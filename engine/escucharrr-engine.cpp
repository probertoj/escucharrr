// escucharrr — motor de audio nativo (esqueleto)
//
// Renderizador WASAPI en float32. No decodifica: recibe PCM float32
// intercalado (f32le) por stdin y lo saca por un dispositivo WASAPI, en modo
// compartido (con ganancia maestra) o exclusivo (bit-perfect, sin tocar la
// muestra). La capa de decodificación la pone quien alimenta stdin (hoy
// ffmpeg; libFLAC/dr_flac en el futuro) — ver native-player.js.
//
// Esto implementa la parte del §4 del documento de diseño que SÍ tiene que ser
// nativa: pipeline float interno → DSP → salida WASAPI, con bypass bit-perfect.
// El grafo DSP encadenable (resample soxr, convolución, dither) son ranuras
// documentadas para más adelante; por ahora el único nodo es la ganancia.
//
//   escucharrr-engine --list-devices
//   escucharrr-engine --play --rate 44100 --channels 2 [--device-id <id>]
//                      [--exclusive] [--gain <lineal>]     (PCM f32le por stdin)
//
// Compilar con build.ps1 (MSVC). Sin dependencias externas: solo Windows SDK.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

static const REFERENCE_TIME REFTIMES_PER_SEC = 10000000; // 100ns por unidad

// --------------------------------------------------------------------------
// utilidades
// --------------------------------------------------------------------------

static std::string wide_to_utf8(const wchar_t* w) {
    if (!w) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return std::string();
    std::string s((size_t)n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}

static std::wstring utf8_to_wide(const char* s) {
    if (!s) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring w((size_t)n - 1, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
    return w;
}

// Escapa una cadena para emitirla como valor JSON.
static std::string json_escape(const std::string& in) {
    std::string o;
    o.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n";  break;
            case '\r': o += "\\r";  break;
            case '\t': o += "\\t";  break;
            default:
                if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}

// Imprime una línea de evento JSON por stdout y la vacía (el bridge la lee).
static void emit(const std::string& json) {
    fputs(json.c_str(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void emit_error(const std::string& msg) {
    emit("{\"event\":\"error\",\"message\":\"" + json_escape(msg) + "\"}");
}

#define HR_OK(hr) (SUCCEEDED(hr))

// --------------------------------------------------------------------------
// listar dispositivos de salida (análogo nativo de enumerateDevices)
// --------------------------------------------------------------------------

static int list_devices() {
    IMMDeviceEnumerator* en = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  (void**)&en);
    if (!HR_OK(hr)) { emit_error("no se pudo crear MMDeviceEnumerator"); return 1; }

    // id del predeterminado, para marcarlo
    std::string defaultId;
    IMMDevice* def = nullptr;
    if (HR_OK(en->GetDefaultAudioEndpoint(eRender, eConsole, &def)) && def) {
        LPWSTR id = nullptr;
        if (HR_OK(def->GetId(&id))) { defaultId = wide_to_utf8(id); CoTaskMemFree(id); }
        def->Release();
    }

    IMMDeviceCollection* coll = nullptr;
    hr = en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll);
    if (!HR_OK(hr)) { emit_error("EnumAudioEndpoints falló"); en->Release(); return 1; }

    UINT count = 0;
    coll->GetCount(&count);
    std::string out = "{\"event\":\"devices\",\"items\":[";
    bool first = true;
    for (UINT i = 0; i < count; i++) {
        IMMDevice* dev = nullptr;
        if (!HR_OK(coll->Item(i, &dev)) || !dev) continue;

        LPWSTR id = nullptr;
        std::string sid;
        if (HR_OK(dev->GetId(&id))) { sid = wide_to_utf8(id); CoTaskMemFree(id); }

        std::string name;
        IPropertyStore* props = nullptr;
        if (HR_OK(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
            PROPVARIANT v; PropVariantInit(&v);
            if (HR_OK(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR)
                name = wide_to_utf8(v.pwszVal);
            PropVariantClear(&v);
            props->Release();
        }

        // formato de mezcla (modo compartido): rate / canales / bits
        unsigned rate = 0, ch = 0, bits = 0;
        IAudioClient* ac = nullptr;
        if (HR_OK(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&ac)) && ac) {
            WAVEFORMATEX* mix = nullptr;
            if (HR_OK(ac->GetMixFormat(&mix)) && mix) {
                rate = mix->nSamplesPerSec; ch = mix->nChannels; bits = mix->wBitsPerSample;
                CoTaskMemFree(mix);
            }
            ac->Release();
        }

        if (!first) out += ",";
        first = false;
        out += "{\"id\":\"" + json_escape(sid) + "\",";
        out += "\"name\":\"" + json_escape(name) + "\",";
        out += "\"default\":" + std::string(sid == defaultId ? "true" : "false") + ",";
        out += "\"rate\":" + std::to_string(rate) + ",";
        out += "\"channels\":" + std::to_string(ch) + ",";
        out += "\"bits\":" + std::to_string(bits) + "}";

        dev->Release();
    }
    out += "]}";
    emit(out);

    coll->Release();
    en->Release();
    return 0;
}

// --------------------------------------------------------------------------
// buffer en anillo: el hilo lector de stdin escribe, el de audio lee
// --------------------------------------------------------------------------

struct Ring {
    std::vector<char> buf;
    size_t head = 0, tail = 0, used = 0;
    CRITICAL_SECTION cs;
    CONDITION_VARIABLE notEmpty, notFull;
    bool eof = false;

    explicit Ring(size_t cap) : buf(cap) {
        InitializeCriticalSection(&cs);
        InitializeConditionVariable(&notEmpty);
        InitializeConditionVariable(&notFull);
    }
    ~Ring() { DeleteCriticalSection(&cs); }

    // escribe n bytes (bloquea si está lleno). Devuelve false si se canceló.
    bool write(const char* p, size_t n) {
        EnterCriticalSection(&cs);
        size_t off = 0;
        while (off < n) {
            while (used == buf.size() && !cancelled)
                SleepConditionVariableCS(&notFull, &cs, INFINITE);
            if (cancelled) { LeaveCriticalSection(&cs); return false; }
            size_t space = buf.size() - used;
            size_t chunk = n - off < space ? n - off : space;
            for (size_t i = 0; i < chunk; i++) { buf[tail] = p[off + i]; tail = (tail + 1) % buf.size(); }
            used += chunk; off += chunk;
            WakeConditionVariable(&notEmpty);
        }
        LeaveCriticalSection(&cs);
        return true;
    }

    // lee hasta n bytes en p; devuelve cuántos leyó. 0 solo si EOF y vacío.
    size_t read(char* p, size_t n) {
        EnterCriticalSection(&cs);
        while (used == 0 && !eof && !cancelled)
            SleepConditionVariableCS(&notEmpty, &cs, INFINITE);
        size_t avail = used < n ? used : n;
        for (size_t i = 0; i < avail; i++) { p[i] = buf[head]; head = (head + 1) % buf.size(); }
        used -= avail;
        WakeConditionVariable(&notFull);
        LeaveCriticalSection(&cs);
        return avail;
    }

    void setEof() { EnterCriticalSection(&cs); eof = true; WakeAllConditionVariable(&notEmpty); LeaveCriticalSection(&cs); }
    void cancel() { EnterCriticalSection(&cs); cancelled = true; WakeAllConditionVariable(&notEmpty); WakeAllConditionVariable(&notFull); LeaveCriticalSection(&cs); }
    bool isDrained() { EnterCriticalSection(&cs); bool d = (used == 0 && eof); LeaveCriticalSection(&cs); return d; }

    volatile bool cancelled = false;
};

static Ring* g_ring = nullptr;

static DWORD WINAPI stdin_reader(LPVOID) {
    const size_t CH = 1 << 15; // 32 KiB
    std::vector<char> tmp(CH);
    int fd = _fileno(stdin);
    for (;;) {
        int got = _read(fd, tmp.data(), (unsigned)tmp.size());
        if (got <= 0) break;            // EOF o error
        if (!g_ring->write(tmp.data(), (size_t)got)) break;
    }
    g_ring->setEof();
    return 0;
}

// --------------------------------------------------------------------------
// reproducir stream PCM f32le por WASAPI
// --------------------------------------------------------------------------

static IMMDevice* pick_device(IMMDeviceEnumerator* en, const std::string& deviceId) {
    IMMDevice* dev = nullptr;
    if (!deviceId.empty()) {
        std::wstring wid = utf8_to_wide(deviceId.c_str());
        if (HR_OK(en->GetDevice(wid.c_str(), &dev)) && dev) return dev;
    }
    en->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
    return dev;
}

// Construye un WAVEFORMATEXTENSIBLE float32.
static void make_float_format(WAVEFORMATEXTENSIBLE& wf, unsigned rate, unsigned ch) {
    ZeroMemory(&wf, sizeof(wf));
    wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wf.Format.nChannels = (WORD)ch;
    wf.Format.nSamplesPerSec = rate;
    wf.Format.wBitsPerSample = 32;
    wf.Format.nBlockAlign = (WORD)(ch * 4);
    wf.Format.nAvgBytesPerSec = rate * wf.Format.nBlockAlign;
    wf.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    wf.Samples.wValidBitsPerSample = 32;
    wf.dwChannelMask = (ch == 1) ? SPEAKER_FRONT_CENTER
                                 : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT);
    wf.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
}

static int play_stream(unsigned reqRate, unsigned reqCh, bool exclusive,
                       float gain, const std::string& deviceId) {
    IMMDeviceEnumerator* en = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                                  CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  (void**)&en);
    if (!HR_OK(hr)) { emit_error("no se pudo crear MMDeviceEnumerator"); return 1; }

    IMMDevice* dev = pick_device(en, deviceId);
    if (!dev) { emit_error("no hay dispositivo de salida"); en->Release(); return 1; }

    std::string devName;
    { IPropertyStore* props = nullptr;
      if (HR_OK(dev->OpenPropertyStore(STGM_READ, &props)) && props) {
          PROPVARIANT v; PropVariantInit(&v);
          if (HR_OK(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR)
              devName = wide_to_utf8(v.pwszVal);
          PropVariantClear(&v); props->Release();
      } }

    IAudioClient* ac = nullptr;
    hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&ac);
    if (!HR_OK(hr)) { emit_error("Activate(IAudioClient) falló"); dev->Release(); en->Release(); return 1; }

    AUDCLNT_SHAREMODE mode = exclusive ? AUDCLNT_SHAREMODE_EXCLUSIVE : AUDCLNT_SHAREMODE_SHARED;
    WAVEFORMATEX* useFmt = nullptr;   // formato realmente usado (liberar si proviene de GetMixFormat)
    WAVEFORMATEXTENSIBLE exFmt;
    bool freeUseFmt = false;
    bool bitPerfect = false;

    if (exclusive) {
        // bit-perfect: proponemos float32 al rate pedido (nativo del fichero).
        make_float_format(exFmt, reqRate, reqCh);
        hr = ac->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, (WAVEFORMATEX*)&exFmt, nullptr);
        if (HR_OK(hr)) { useFmt = (WAVEFORMATEX*)&exFmt; bitPerfect = true; }
        else {
            // el dispositivo no acepta ese formato en exclusivo → caemos a compartido
            emit("{\"event\":\"notice\",\"message\":\"exclusivo no soportado para este formato; usando compartido\"}");
            mode = AUDCLNT_SHAREMODE_SHARED;
        }
    }
    if (!useFmt) {
        // modo compartido: usamos el formato de mezcla del dispositivo
        hr = ac->GetMixFormat(&useFmt);
        if (!HR_OK(hr) || !useFmt) { emit_error("GetMixFormat falló"); ac->Release(); dev->Release(); en->Release(); return 1; }
        freeUseFmt = true;
    }

    // Comprobamos que el stream de entrada case con el formato de salida.
    if (useFmt->nSamplesPerSec != reqRate || useFmt->nChannels != reqCh) {
        emit("{\"event\":\"notice\",\"message\":\"el formato del stream (" +
             std::to_string(reqRate) + "/" + std::to_string(reqCh) +
             ") no coincide con el del dispositivo (" +
             std::to_string(useFmt->nSamplesPerSec) + "/" + std::to_string(useFmt->nChannels) +
             "); el que alimenta stdin debe adaptarlo\"}");
    }

    // ¿La salida espera float32? (en compartido casi siempre sí). Si no, avisamos:
    bool outIsFloat = false;
    if (useFmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) outIsFloat = true;
    else if (useFmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        WAVEFORMATEXTENSIBLE* wfx = (WAVEFORMATEXTENSIBLE*)useFmt;
        outIsFloat = (wfx->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
    }
    if (!outIsFloat)
        emit("{\"event\":\"notice\",\"message\":\"el dispositivo no usa float32 nativo; conversión no implementada en el esqueleto\"}");

    REFERENCE_TIME dur = REFTIMES_PER_SEC / 10; // ~100 ms
    DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    hr = ac->Initialize(mode, flags, dur, exclusive ? dur : 0, useFmt, nullptr);
    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED && exclusive) {
        // realineado requerido en exclusivo: recalculamos la duración
        UINT32 bf = 0; ac->GetBufferSize(&bf);
        dur = (REFERENCE_TIME)(10000.0 * 1000 / useFmt->nSamplesPerSec * bf + 0.5);
        ac->Release();
        dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&ac);
        hr = ac->Initialize(mode, flags, dur, dur, useFmt, nullptr);
    }
    if (!HR_OK(hr)) {
        char b[64]; sprintf_s(b, "0x%08lx", (unsigned long)hr);
        emit_error(std::string("IAudioClient::Initialize falló ") + b);
        if (freeUseFmt) CoTaskMemFree(useFmt);
        ac->Release(); dev->Release(); en->Release(); return 1;
    }

    UINT32 bufFrames = 0;
    ac->GetBufferSize(&bufFrames);

    HANDLE hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    ac->SetEventHandle(hEvent);

    IAudioRenderClient* rc = nullptr;
    hr = ac->GetService(__uuidof(IAudioRenderClient), (void**)&rc);
    if (!HR_OK(hr)) { emit_error("GetService(IAudioRenderClient) falló"); CloseHandle(hEvent); if (freeUseFmt) CoTaskMemFree(useFmt); ac->Release(); dev->Release(); en->Release(); return 1; }

    const WORD frameBytes = useFmt->nBlockAlign;
    const WORD channels = useFmt->nChannels;
    const bool applyGain = !bitPerfect && outIsFloat && (gain != 1.0f);

    // formato de salida resuelto
    emit("{\"event\":\"started\",\"device\":\"" + json_escape(devName) +
         "\",\"mode\":\"" + (exclusive && bitPerfect ? "exclusive" : "shared") +
         "\",\"bitPerfect\":" + (bitPerfect ? "true" : "false") +
         ",\"rate\":" + std::to_string(useFmt->nSamplesPerSec) +
         ",\"channels\":" + std::to_string(channels) +
         ",\"bufferFrames\":" + std::to_string(bufFrames) +
         ",\"gain\":" + std::to_string(bitPerfect ? 1.0f : gain) + "}");

    // Subimos la prioridad del hilo de audio (MMCSS) como hace un motor serio.
    DWORD taskIndex = 0;
    HANDLE hTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    ac->Start();

    unsigned long long totalFrames = 0;
    std::vector<char> scratch;
    bool running = true;
    while (running) {
        DWORD w = WaitForSingleObject(hEvent, 200);
        if (w != WAIT_OBJECT_0) {
            // timeout: si el stream terminó y el anillo está vacío, salimos
            if (g_ring->isDrained()) break;
            continue;
        }
        UINT32 padding = 0;
        if (!HR_OK(ac->GetCurrentPadding(&padding))) break;
        UINT32 avail = exclusive ? bufFrames : (bufFrames - padding);
        if (avail == 0) continue;

        BYTE* out = nullptr;
        if (!HR_OK(rc->GetBuffer(avail, &out))) break;

        size_t wantBytes = (size_t)avail * frameBytes;
        if (scratch.size() < wantBytes) scratch.resize(wantBytes);
        size_t got = g_ring->read(scratch.data(), wantBytes);

        // frames completos realmente disponibles
        UINT32 gotFrames = (UINT32)(got / frameBytes);
        if (gotFrames > 0) {
            memcpy(out, scratch.data(), (size_t)gotFrames * frameBytes);
            if (applyGain) {
                float* f = (float*)out;
                size_t samples = (size_t)gotFrames * channels;
                for (size_t i = 0; i < samples; i++) f[i] *= gain;
            }
        }
        // rellenar el resto con silencio si hubo underrun / fin de stream
        if (gotFrames < avail) {
            memset(out + (size_t)gotFrames * frameBytes, 0,
                   (size_t)(avail - gotFrames) * frameBytes);
        }
        rc->ReleaseBuffer(avail, 0);
        totalFrames += gotFrames;

        if (gotFrames == 0 && g_ring->isDrained()) running = false;
    }

    // drenar el buffer del dispositivo antes de parar
    Sleep((DWORD)(dur / (REFTIMES_PER_SEC / 1000)) + 50);
    ac->Stop();

    if (hTask) AvRevertMmThreadCharacteristics(hTask);
    emit("{\"event\":\"ended\",\"frames\":" + std::to_string(totalFrames) + "}");

    rc->Release();
    CloseHandle(hEvent);
    if (freeUseFmt) CoTaskMemFree(useFmt);
    ac->Release();
    dev->Release();
    en->Release();
    return 0;
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

int main(int argc, char** argv) {
    bool doList = false, doPlay = false, exclusive = false;
    unsigned rate = 44100, channels = 2;
    float gain = 1.0f;
    std::string deviceId;

    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--list-devices") doList = true;
        else if (a == "--play") doPlay = true;
        else if (a == "--exclusive") exclusive = true;
        else if (a == "--rate" && i + 1 < argc) rate = (unsigned)atoi(argv[++i]);
        else if (a == "--channels" && i + 1 < argc) channels = (unsigned)atoi(argv[++i]);
        else if (a == "--gain" && i + 1 < argc) gain = (float)atof(argv[++i]);
        else if (a == "--device-id" && i + 1 < argc) deviceId = argv[++i];
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (!HR_OK(hr)) { emit_error("CoInitializeEx falló"); return 1; }

    int rc = 0;
    if (doList) {
        rc = list_devices();
    } else if (doPlay) {
        _setmode(_fileno(stdin), _O_BINARY);     // PCM crudo por stdin
        Ring ring(1 << 21);                       // 2 MiB de colchón
        g_ring = &ring;
        HANDLE hReader = CreateThread(nullptr, 0, stdin_reader, nullptr, 0, nullptr);
        rc = play_stream(rate, channels, exclusive, gain, deviceId);
        ring.cancel();
        if (hReader) { WaitForSingleObject(hReader, 1000); CloseHandle(hReader); }
        g_ring = nullptr;
    } else {
        emit_error("uso: --list-devices | --play --rate R --channels C [--exclusive] [--gain G] [--device-id ID]");
        rc = 2;
    }

    CoUninitialize();
    return rc;
}
