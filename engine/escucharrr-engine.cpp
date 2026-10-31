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
#define _USE_MATH_DEFINES
#include <windows.h>
#include <math.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
    void clear() { EnterCriticalSection(&cs); head = tail = used = 0; WakeAllConditionVariable(&notFull); LeaveCriticalSection(&cs); }   // descarta lo pendiente (seek)

    volatile bool cancelled = false;
};

static Ring* g_ring = nullptr;
// ── control en vivo (modo named pipe): el hilo de control escribe, el de audio lee ──
static volatile float g_gainLive = 1.0f;   // ganancia maestra en vivo (compartido/float)
static volatile long  g_paused = 0;         // 1 = silencio sin consumir el anillo
static volatile long  g_stop = 0;           // 1 = terminar
static std::wstring   g_pcmPipe;            // ruta del named pipe de PCM (vacío = PCM por stdin)

// ── ecualizador de 7 bandas (biquad, mismas frecuencias que el player web) ──
static const double EQ_FREQ[7] = { 60, 150, 400, 1000, 2400, 6000, 15000 };
static const double EQ_Q = 1.1;             // Q de las bandas peaking
static CRITICAL_SECTION g_eqCs;             // protege g_eqGainReq
static float          g_eqGainReq[7] = { 0, 0, 0, 0, 0, 0, 0 };   // ganancias por banda (dB)
static volatile long  g_eqOn = 0;
static volatile long  g_eqDirty = 0;        // 1 = recalcular coeficientes en el hilo de audio
struct Biquad {                             // forma directa transpuesta II, estado por canal
    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    inline float process(float x) { float y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y; }
};
// Coeficientes RBJ (lowshelf / peaking / highshelf) normalizados por a0.
static void eq_coeffs(Biquad& bq, int band, double gainDb, double Fs) {
    double A = pow(10.0, gainDb / 40.0);
    double w0 = 2.0 * M_PI * EQ_FREQ[band] / Fs, cw = cos(w0), sw = sin(w0);
    double b0, b1, b2, a0, a1, a2;
    if (band == 0 || band == 6) {                                   // shelf (S=1)
        double alpha = sw / 2.0 * sqrt(2.0);
        double tsa = 2.0 * sqrt(A) * alpha;
        if (band == 0) {                                            // lowshelf
            b0 = A * ((A + 1) - (A - 1) * cw + tsa);  b1 = 2 * A * ((A - 1) - (A + 1) * cw);  b2 = A * ((A + 1) - (A - 1) * cw - tsa);
            a0 = (A + 1) + (A - 1) * cw + tsa;        a1 = -2 * ((A - 1) + (A + 1) * cw);     a2 = (A + 1) + (A - 1) * cw - tsa;
        } else {                                                    // highshelf
            b0 = A * ((A + 1) + (A - 1) * cw + tsa);  b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - tsa);
            a0 = (A + 1) - (A - 1) * cw + tsa;        a1 = 2 * ((A - 1) - (A + 1) * cw);      a2 = (A + 1) - (A - 1) * cw - tsa;
        }
    } else {                                                        // peaking
        double alpha = sw / (2.0 * EQ_Q);
        b0 = 1 + alpha * A;  b1 = -2 * cw;  b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;  a1 = -2 * cw;  a2 = 1 - alpha / A;
    }
    bq.b0 = (float)(b0 / a0); bq.b1 = (float)(b1 / a0); bq.b2 = (float)(b2 / a0);
    bq.a1 = (float)(a1 / a0); bq.a2 = (float)(a2 / a0);
}

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
// Lee PCM de un named pipe (el bridge es el servidor; aquí conectamos como cliente).
// El pipe queda abierto toda la sesión aunque el que alimenta (ffmpeg) se reinicie en un seek.
static DWORD WINAPI pipe_reader(LPVOID) {
    HANDLE h = INVALID_HANDLE_VALUE;
    for (int i = 0; i < 200 && !g_stop; i++) {
        h = CreateFileW(g_pcmPipe.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h != INVALID_HANDLE_VALUE) break;
        if (GetLastError() == ERROR_PIPE_BUSY) WaitNamedPipeW(g_pcmPipe.c_str(), 2000);
        else Sleep(50);
    }
    if (h == INVALID_HANDLE_VALUE) { emit_error("no se pudo abrir el named pipe de PCM"); g_ring->setEof(); return 1; }
    const DWORD CH = 1 << 15;
    std::vector<char> tmp(CH); DWORD got = 0;
    while (!g_stop && ReadFile(h, tmp.data(), CH, &got, nullptr) && got > 0)
        if (!g_ring->write(tmp.data(), (size_t)got)) break;
    CloseHandle(h);
    g_ring->setEof();
    return 0;
}
// Lee comandos de control (una línea JSON por comando) por stdin:
//   {"cmd":"gain","v":<lineal>} {"cmd":"pause"} {"cmd":"resume"} {"cmd":"flush"} {"cmd":"stop"}
static DWORD WINAPI control_reader(LPVOID) {
    char line[512];
    while (!g_stop && fgets(line, sizeof(line), stdin)) {
        if (!strstr(line, "\"cmd\"")) continue;
        if (strstr(line, "\"gain\"")) { const char* v = strstr(line, "\"v\""); if (v) { v = strchr(v, ':'); if (v) g_gainLive = (float)atof(v + 1); } }
        else if (strstr(line, "\"eq\"")) {
            g_eqOn = (strstr(line, "\"on\":true") || strstr(line, "\"on\":1")) ? 1 : 0;
            const char* g = strstr(line, "\"g\""); if (g) g = strchr(g, '[');
            if (g) { g++; EnterCriticalSection(&g_eqCs); for (int k = 0; k < 7; k++) { char* end; double v = strtod(g, &end); if (end == g) break; g_eqGainReq[k] = (float)v; g = end; while (*g == ',' || *g == ' ') g++; } LeaveCriticalSection(&g_eqCs); }
            g_eqDirty = 1;
        }
        else if (strstr(line, "\"pause\""))  g_paused = 1;
        else if (strstr(line, "\"resume\"")) g_paused = 0;
        else if (strstr(line, "\"flush\""))  { if (g_ring) g_ring->clear(); }
        else if (strstr(line, "\"stop\""))   { g_stop = 1; if (g_ring) g_ring->cancel(); break; }
    }
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
                       float gain, const std::string& deviceId, bool liveControl) {
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
    const bool canGain = !bitPerfect && outIsFloat;   // en bit-perfect la muestra sale intacta

    // formato de salida resuelto
    emit("{\"event\":\"started\",\"device\":\"" + json_escape(devName) +
         "\",\"mode\":\"" + (exclusive && bitPerfect ? "exclusive" : "shared") +
         "\",\"bitPerfect\":" + (bitPerfect ? "true" : "false") +
         ",\"rate\":" + std::to_string(useFmt->nSamplesPerSec) +
         ",\"channels\":" + std::to_string(channels) +
         ",\"bufferFrames\":" + std::to_string(bufFrames) +
         ",\"live\":" + (liveControl ? "true" : "false") +
         ",\"gain\":" + std::to_string(bitPerfect ? 1.0f : gain) + "}");

    // Subimos la prioridad del hilo de audio (MMCSS) como hace un motor serio.
    DWORD taskIndex = 0;
    HANDLE hTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    ac->Start();

    unsigned long long totalFrames = 0;
    std::vector<char> scratch;
    Biquad eq[8][7];
    const int eqCh = (channels <= 8) ? channels : 0;   // EQ hasta 8 canales
    bool running = true;
    while (running) {
        if (liveControl && g_stop) break;
        DWORD w = WaitForSingleObject(hEvent, 200);
        if (w != WAIT_OBJECT_0) {
            // timeout: en modo stdin, si el stream terminó y el anillo está vacío, salimos
            if (!liveControl && g_ring->isDrained()) break;
            continue;
        }
        UINT32 padding = 0;
        if (!HR_OK(ac->GetCurrentPadding(&padding))) break;
        UINT32 avail = exclusive ? bufFrames : (bufFrames - padding);
        if (avail == 0) continue;

        BYTE* out = nullptr;
        if (!HR_OK(rc->GetBuffer(avail, &out))) break;

        if (liveControl && g_paused) {   // en pausa: silencio sin consumir el anillo (el feeder hace backpressure)
            memset(out, 0, (size_t)avail * frameBytes);
            rc->ReleaseBuffer(avail, 0);
            continue;
        }

        size_t wantBytes = (size_t)avail * frameBytes;
        if (scratch.size() < wantBytes) scratch.resize(wantBytes);
        size_t got = g_ring->read(scratch.data(), wantBytes);

        UINT32 gotFrames = (UINT32)(got / frameBytes);   // frames completos disponibles
        if (gotFrames > 0) {
            memcpy(out, scratch.data(), (size_t)gotFrames * frameBytes);
            const float gnow = liveControl ? g_gainLive : gain;
            const bool doGain = canGain && gnow != 1.0f;
            const bool doEq = canGain && g_eqOn && eqCh > 0;
            if (doEq && InterlockedExchange(&g_eqDirty, 0)) {       // recalcula coeficientes al cambiar
                EnterCriticalSection(&g_eqCs);
                for (int c = 0; c < eqCh; c++) for (int bnd = 0; bnd < 7; bnd++) eq_coeffs(eq[c][bnd], bnd, g_eqGainReq[bnd], (double)useFmt->nSamplesPerSec);
                LeaveCriticalSection(&g_eqCs);
            }
            if (doGain || doEq) {                                   // ganancia (RG×vol) primero, luego EQ
                float* f = (float*)out;
                for (UINT32 i = 0; i < gotFrames; i++)
                    for (int c = 0; c < (int)channels; c++) {
                        float s = f[i * channels + c];
                        if (doGain) s *= gnow;
                        if (doEq) for (int bnd = 0; bnd < 7; bnd++) s = eq[c][bnd].process(s);
                        f[i * channels + c] = s;
                    }
            }
        }
        // silencio en el resto si hubo underrun / fin de stream (en live esperamos más PCM)
        if (gotFrames < avail)
            memset(out + (size_t)gotFrames * frameBytes, 0, (size_t)(avail - gotFrames) * frameBytes);
        rc->ReleaseBuffer(avail, 0);
        totalFrames += gotFrames;

        if (!liveControl && gotFrames == 0 && g_ring->isDrained()) running = false;
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
        else if (a == "--pcm-pipe" && i + 1 < argc) g_pcmPipe = utf8_to_wide(argv[++i]);
    }

    InitializeCriticalSection(&g_eqCs);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (!HR_OK(hr)) { emit_error("CoInitializeEx falló"); return 1; }

    int rc = 0;
    if (doList) {
        rc = list_devices();
    } else if (doPlay) {
        Ring ring(1 << 21);                       // 2 MiB de colchón
        g_ring = &ring;
        const bool live = !g_pcmPipe.empty();     // con --pcm-pipe: PCM por pipe + control por stdin
        g_gainLive = gain;
        HANDLE hReader = nullptr, hCtl = nullptr;
        if (live) {
            hReader = CreateThread(nullptr, 0, pipe_reader, nullptr, 0, nullptr);
            hCtl = CreateThread(nullptr, 0, control_reader, nullptr, 0, nullptr);
        } else {
            _setmode(_fileno(stdin), _O_BINARY);  // PCM crudo por stdin
            hReader = CreateThread(nullptr, 0, stdin_reader, nullptr, 0, nullptr);
        }
        rc = play_stream(rate, channels, exclusive, gain, deviceId, live);
        g_stop = 1; ring.cancel();
        if (hReader) { WaitForSingleObject(hReader, 1000); CloseHandle(hReader); }
        if (hCtl) { WaitForSingleObject(hCtl, 200); CloseHandle(hCtl); }
        g_ring = nullptr;
    } else {
        emit_error("uso: --list-devices | --play --rate R --channels C [--exclusive] [--gain G] [--device-id ID]");
        rc = 2;
    }

    CoUninitialize();
    return rc;
}
