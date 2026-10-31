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
// Grafo DSP: resample (sinc Kaiser polifásico) → ganancia → EQ de 7 bandas, y
// cuantización con dither TPDF si la salida es PCM entero. El resample iguala la
// entrada a la tasa de mezcla del dispositivo para que WASAPI NO vuelva a remuestrear.
// Quedan como ranura la convolución/noise-shaping; la decodificación la pone quien
// alimenta stdin (hoy ffmpeg, a la tasa NATIVA del fichero).
//
//   escucharrr-engine --list-devices
//   escucharrr-engine --selftest                            (autoprueba numérica del DSP)
//   escucharrr-engine --play --rate 48000 --channels 2 [--in-rate 44100]
//                      [--device-id <id>] [--exclusive] [--gain <lineal>] [--rs-taps N]
//                      (PCM f32le por stdin o --pcm-pipe; --in-rate = tasa del fichero)
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

// ── control de tasa de entrada en vivo (cambio de pista con otro sample rate) ──
static volatile long g_inRateReq = 0;       // nueva tasa de entrada pedida (Hz)
static volatile long g_inRateDirty = 0;     // 1 = reconstruir el resampler en el hilo de audio

// ── nodo DSP de resample: sinc enventanado Kaiser, polifásico ───────────────────
// Igualamos la entrada (tasa del fichero) a la tasa de mezcla del dispositivo para que
// WASAPI NO vuelva a remuestrear: sustituimos su SRC interno por uno de alta calidad.
// Racional L/M (L=out/g, M=in/g); si in==out no se crea (paso directo bit a bit).
// Lineal-fase; la latencia de grupo es constante e irrelevante para el reloj de pared.
static int    RS_TAPS = 64;                  // taps por fase (calidad); --rs-taps lo cambia
static double RS_BETA = 9.0;                 // Kaiser beta (≈ 90 dB de rechazo)
static double RS_ROLLOFF = 0.918;            // banda de paso plana hasta ~0.918·Nyquist (~20 kHz @44.1k)

static double bessel_i0(double x) {          // I0 modificada de Bessel (ventana Kaiser)
    double sum = 1.0, term = 1.0, k = 1.0, x2 = x * x / 4.0;
    while (term > sum * 1e-14) { term *= x2 / (k * k); sum += term; k += 1.0; }
    return sum;
}
static unsigned gcd_u(unsigned a, unsigned b) { while (b) { unsigned t = a % b; a = b; b = t; } return a; }

struct Resampler {
    int ch = 1, L = 1, M = 1, tpp = 0;       // tpp = taps por fase
    std::vector<float> poly;                 // L*tpp: poly[p*tpp+m] = h[p + m*L]
    std::vector<float> buf;                  // ventana de entrada intercalada (ch floats por frame)
    long long inBase = 0, nextIn = 0, i0 = 0;
    int p = 0;

    Resampler(int channels, unsigned inRate, unsigned outRate, int tapsPerPhase, double beta) {
        ch = channels > 0 ? channels : 1;
        unsigned g = gcd_u(inRate, outRate);
        L = (int)(outRate / g); M = (int)(inRate / g);
        tpp = tapsPerPhase;
        int N = tpp * L;                     // taps totales del prototipo
        poly.assign((size_t)L * tpp, 0.0f);
        double fc = RS_ROLLOFF * 0.5 / (double)(L > M ? L : M);   // corte normalizado (con rolloff) en el dominio sobremuestreado
        int center = (N - 1) / 2;
        double denom = bessel_i0(beta);
        for (int i = 0; i < N; i++) {
            double m = i - center;
            double s = (m == 0.0) ? 2.0 * fc : sin(2.0 * M_PI * fc * m) / (M_PI * m);
            double r = (N > 1) ? ((double)i / (N - 1) * 2.0 - 1.0) : 0.0;
            double w = bessel_i0(beta * sqrt(1.0 - r * r)) / denom;
            int ph = i % L, mm = i / L;
            if (mm < tpp) poly[(size_t)ph * tpp + mm] = (float)(s * w);
        }
        // normaliza cada subfiltro a ganancia unidad en continua → paso de banda ≈ 0 dB
        for (int ph = 0; ph < L; ph++) {
            double s = 0; for (int m = 0; m < tpp; m++) s += poly[(size_t)ph * tpp + m];
            if (s != 0.0) for (int m = 0; m < tpp; m++) poly[(size_t)ph * tpp + m] /= (float)s;
        }
    }
    void reset() { buf.clear(); inBase = nextIn = i0 = 0; p = 0; }
    bool empty() const { return i0 >= nextIn; }        // sin entrada pendiente para producir más

    void push(const float* x, size_t frames) {
        size_t off = buf.size();
        buf.resize(off + frames * (size_t)ch);
        memcpy(buf.data() + off, x, frames * (size_t)ch * sizeof(float));
        nextIn += (long long)frames;
    }
    inline float sample(long long abs, int c) const {
        if (abs < inBase) return 0.0f;                 // pre-historia = silencio
        size_t idx = (size_t)(abs - inBase) * ch + c;
        return idx < buf.size() ? buf[idx] : 0.0f;
    }
    // produce hasta maxFrames de salida; se detiene cuando necesita más entrada (i0 >= nextIn)
    size_t pull(float* out, size_t maxFrames) {
        size_t n = 0;
        while (n < maxFrames && i0 < nextIn) {
            const float* ph = &poly[(size_t)p * tpp];
            for (int c = 0; c < ch; c++) {
                float acc = 0.0f;
                for (int m = 0; m < tpp; m++) acc += ph[m] * sample(i0 - m, c);
                out[n * ch + c] = acc;
            }
            n++;
            p += M; i0 += p / L; p %= L;
        }
        compact();
        return n;
    }
    void compact() {                                   // descarta la historia que ya no hace falta
        long long keepFrom = i0 - (tpp - 1);
        if (keepFrom <= inBase) return;
        long long have = (long long)(buf.size() / ch);
        long long drop = keepFrom - inBase;
        if (drop > have) drop = have;
        buf.erase(buf.begin(), buf.begin() + (size_t)drop * ch);
        inBase += drop;
    }
};

// ── cuantización float→entero con dither TPDF (triangular, 1 LSB pp) ─────────────
// Ruta de salida en PCM entero (p. ej. WASAPI exclusivo entero). El modo compartido usa
// float y NO pasa por aquí. Verificado numéricamente en --selftest; la salida entera
// AUDIBLE necesita un DAC exclusivo que no podemos probar en esta máquina.
static unsigned long long g_ditherState = 0x853c49e6748fea9bULL;
static inline double dither_rand() {                   // uniforme [0,1) (PRNG xorshift/lcg barato)
    g_ditherState = g_ditherState * 6364136223846793005ULL + 1442695040888963407ULL;
    return (double)((g_ditherState >> 11) & 0x1FFFFFFFFFFFFFULL) / (double)0x20000000000000ULL;
}
static void float_to_int(const float* in, BYTE* out, size_t frames, int ch,
                         int bytesPerSample, int validBits, bool dither) {
    const double full = (double)(1LL << (validBits - 1));      // 32768.0 para 16 bits
    const long long maxv = (1LL << (validBits - 1)) - 1, minv = -(1LL << (validBits - 1));
    const int shift = (bytesPerSample * 8) - validBits;        // alinea en el contenedor (24→32)
    const size_t nvals = frames * (size_t)ch;
    for (size_t i = 0; i < nvals; i++) {
        double s = (double)in[i] * full;
        if (dither) s += dither_rand() - dither_rand();        // TPDF: ±1 LSB triangular
        long long v = (long long)llround(s);
        if (v > maxv) v = maxv; else if (v < minv) v = minv;
        v <<= shift;
        BYTE* d = out + i * (size_t)bytesPerSample;
        for (int b = 0; b < bytesPerSample; b++) d[b] = (BYTE)((v >> (8 * b)) & 0xFF);   // little-endian
    }
}

// ── autoprueba numérica (sin hardware de audio): mide el resampler y el dither ──
static double goertzel_amp(const float* x, size_t n, double freq, double fs) {
    double w = 2.0 * M_PI * freq / fs, c = 2.0 * cos(w), s1 = 0, s2 = 0;
    for (size_t i = 0; i < n; i++) { double s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    double re = s1 - s2 * cos(w), im = s2 * sin(w);
    return 2.0 * sqrt(re * re + im * im) / (double)n;          // ≈ amplitud del tono
}
static std::vector<float> resample_tone(unsigned in, unsigned out, double hz, double amp) {
    std::vector<float> x(in);                                  // 1 s de entrada mono
    for (size_t i = 0; i < in; i++) x[i] = (float)(amp * sin(2.0 * M_PI * hz * i / in));
    if (in == out) return x;
    Resampler rs(1, in, out, RS_TAPS, RS_BETA);
    std::vector<float> y; y.reserve(out + 64);
    std::vector<float> tmp(4096);
    size_t pos = 0;
    while (pos < x.size() || !rs.empty()) {
        if (pos < x.size()) { size_t blk = x.size() - pos < 4096 ? x.size() - pos : 4096; rs.push(&x[pos], blk); pos += blk; }
        for (;;) { size_t g = rs.pull(tmp.data(), tmp.size()); if (!g) break; y.insert(y.end(), tmp.begin(), tmp.begin() + g); }
        if (pos >= x.size() && rs.empty()) break;
    }
    return y;
}
static double rms_of(const std::vector<float>& v, size_t off, size_t len) {
    double s = 0; for (size_t i = 0; i < len; i++) s += (double)v[off + i] * v[off + i];
    return sqrt(s / (len ? len : 1));
}
static int selftest() {
    std::string out = "{\"event\":\"selftest\",\"taps\":" + std::to_string(RS_TAPS) +
                      ",\"beta\":" + std::to_string(RS_BETA) + ",\"resampler\":[";
    struct Pair { unsigned in, out; } pairs[] = { {44100,48000}, {48000,44100}, {96000,48000}, {88200,44100}, {44100,44100} };
    bool first = true;
    for (auto& pr : pairs) {
        // planitud de la banda de paso: ganancia a 1 kHz y a 19 kHz (debe ser ≈ 0 dB)
        auto gain_at = [&](double hz) {
            std::vector<float> y = resample_tone(pr.in, pr.out, hz, 0.5);
            size_t off = y.size() / 4, len = y.size() / 2; if (len < 2048) { off = 0; len = y.size(); }
            return 20.0 * log10(goertzel_amp(&y[off], len, hz, pr.out) / 0.5 + 1e-20);
        };
        double pass1k = gain_at(1000.0), pass19k = gain_at(19000.0);
        // rechazo (solo bajada): tono por encima de la Nyquist de salida → debe aliasar poco
        double rejDb = 0; bool hasRej = pr.in > pr.out;
        if (hasRej) {
            double outNyq = pr.out / 2.0, inNyq = pr.in / 2.0, rej = (outNyq + inNyq) / 2.0;
            std::vector<float> yr = resample_tone(pr.in, pr.out, rej, 0.5);
            size_t o2 = yr.size() / 4, l2 = yr.size() / 2; if (l2 < 2048) { o2 = 0; l2 = yr.size(); }
            rejDb = 20.0 * log10(rms_of(yr, o2, l2) / (0.5 / sqrt(2.0)) + 1e-20);
        }
        char b[320];
        sprintf_s(b, "%s{\"in\":%u,\"out\":%u,\"passGainDb@1k\":%.3f,\"passGainDb@19k\":%.3f,%s}",
                  first ? "" : ",", pr.in, pr.out, pass1k, pass19k,
                  hasRej ? (std::string("\"aliasDb\":") + std::to_string(rejDb)).c_str() : "\"aliasDb\":null");
        out += b; first = false;
    }
    out += "],\"dither\":";
    {   // cuantiza un tono bajo (−60 dBFS) a 16 bits: truncado vs TPDF (DC del error de cuantización)
        const size_t N = 48000; std::vector<float> x(N); double f = 997, amp = 0.001;
        for (size_t i = 0; i < N; i++) x[i] = (float)(amp * sin(2.0 * M_PI * f * i / 48000.0));
        std::vector<BYTE> q(N * 2); std::vector<float> back(N);
        auto decode16 = [&]() { for (size_t i = 0; i < N; i++) { short s = (short)((unsigned short)q[i * 2] | ((unsigned short)q[i * 2 + 1] << 8)); back[i] = s / 32768.0f; } };
        float_to_int(x.data(), q.data(), N, 1, 2, 16, false); decode16();
        double dcT = 0; for (size_t i = 0; i < N; i++) dcT += back[i] - x[i]; dcT /= N;
        float_to_int(x.data(), q.data(), N, 1, 2, 16, true); decode16();
        double dcD = 0; for (size_t i = 0; i < N; i++) dcD += back[i] - x[i]; dcD /= N;
        char b[200]; sprintf_s(b, "{\"truncErrDC\":%.3e,\"ditherErrDC\":%.3e}", dcT, dcD);
        out += b;
    }
    out += "}";
    emit(out);
    return 0;
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
        else if (strstr(line, "\"inrate\"")) { const char* v = strstr(line, "\"v\""); if (v) { v = strchr(v, ':'); if (v) { g_inRateReq = atol(v + 1); g_inRateDirty = 1; } } }
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
                       float gain, const std::string& deviceId, bool liveControl, unsigned inRate) {
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
        emit("{\"event\":\"notice\",\"message\":\"el dispositivo usa PCM entero; se cuantiza float→entero con dither TPDF\"}");

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
    const int  chn = (int)channels;
    const bool canGain = !bitPerfect && outIsFloat;   // en bit-perfect la muestra sale intacta

    // Si el dispositivo no es float (p. ej. exclusivo entero), cuantizamos con dither TPDF.
    int intBytes = 0, intValid = 0;                    // 0 = salida float (sin cuantizar)
    if (!outIsFloat) {
        intBytes = frameBytes / (channels ? channels : 1);
        intValid = useFmt->wBitsPerSample;
        if (useFmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            WAVEFORMATEXTENSIBLE* wfx = (WAVEFORMATEXTENSIBLE*)useFmt;
            if (wfx->Samples.wValidBitsPerSample) intValid = wfx->Samples.wValidBitsPerSample;
        }
    }
    const bool ditherOut = (intBytes > 0);

    // Nodo de resample: igualamos la entrada a la tasa de salida para que WASAPI no remuestree.
    const unsigned outRate = useFmt->nSamplesPerSec;
    Resampler* rs = (inRate && inRate != outRate && outIsFloat)
                        ? new Resampler(chn, inRate, outRate, RS_TAPS, RS_BETA) : nullptr;

    // formato de salida resuelto
    const char* outFmt = outIsFloat ? "f32" : (intBytes == 2 ? "s16" : intBytes == 3 ? "s24" : "s32");
    emit("{\"event\":\"started\",\"device\":\"" + json_escape(devName) +
         "\",\"mode\":\"" + (exclusive && bitPerfect ? "exclusive" : "shared") +
         "\",\"bitPerfect\":" + (bitPerfect ? "true" : "false") +
         ",\"rate\":" + std::to_string(outRate) +
         ",\"inRate\":" + std::to_string(inRate ? inRate : outRate) +
         ",\"resampling\":" + (rs ? "true" : "false") +
         ",\"taps\":" + std::to_string(rs ? RS_TAPS : 0) +
         ",\"outFormat\":\"" + outFmt + "\"" +
         ",\"dither\":" + (ditherOut ? "true" : "false") +
         ",\"channels\":" + std::to_string(channels) +
         ",\"bufferFrames\":" + std::to_string(bufFrames) +
         ",\"live\":" + (liveControl ? "true" : "false") +
         ",\"gain\":" + std::to_string(bitPerfect ? 1.0f : gain) + "}");

    // Subimos la prioridad del hilo de audio (MMCSS) como hace un motor serio.
    DWORD taskIndex = 0;
    HANDLE hTask = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    ac->Start();

    unsigned long long totalFrames = 0;
    std::vector<float> fbuf;                            // salida en float (tras resample + DSP)
    std::vector<char>  inbytes;                         // bytes crudos leídos del anillo
    Biquad eq[8][7];
    const int eqCh = (channels <= 8) ? channels : 0;    // EQ hasta 8 canales

    // Rellena `want` frames de SALIDA en dst (float). Con resampler tira de él y lo realimenta
    // desde el anillo (a tasa de entrada); sin él copia directo del anillo. Devuelve frames.
    auto produce = [&](float* dst, UINT32 want) -> UINT32 {
        if (!rs) {
            size_t wantB = (size_t)want * chn * sizeof(float);
            if (inbytes.size() < wantB) inbytes.resize(wantB);
            size_t got = g_ring->read(inbytes.data(), wantB);
            UINT32 gf = (UINT32)(got / (chn * sizeof(float)));
            if (gf) memcpy(dst, inbytes.data(), (size_t)gf * chn * sizeof(float));
            return gf;
        }
        UINT32 done = 0;
        while (done < want) {
            done += (UINT32)rs->pull(dst + (size_t)done * chn, want - done);
            if (done >= want) break;
            size_t need = (size_t)((double)(want - done) * rs->M / rs->L) + (size_t)RS_TAPS + 2;
            size_t wantB = need * chn * sizeof(float);
            if (inbytes.size() < wantB) inbytes.resize(wantB);
            size_t got = g_ring->read(inbytes.data(), wantB);
            size_t gf = got / (chn * sizeof(float));
            if (gf) rs->push((const float*)inbytes.data(), gf);
            else break;                                 // anillo vacío (EOF o underrun)
        }
        return done;
    };

    bool running = true;
    while (running) {
        if (liveControl && g_stop) break;
        DWORD w = WaitForSingleObject(hEvent, 200);
        if (w != WAIT_OBJECT_0) {
            // timeout: en modo stdin, si el stream terminó y todo está vaciado, salimos
            if (!liveControl && g_ring->isDrained() && (!rs || rs->empty())) break;
            continue;
        }
        // cambio de tasa de entrada en vivo (nueva pista con otro sample rate): reconstruye el nodo
        if (liveControl && InterlockedExchange(&g_inRateDirty, 0)) {
            unsigned ni = (unsigned)g_inRateReq;
            if (rs) { delete rs; rs = nullptr; }
            if (ni && ni != outRate && outIsFloat) rs = new Resampler(chn, ni, outRate, RS_TAPS, RS_BETA);
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

        if (fbuf.size() < (size_t)avail * chn) fbuf.resize((size_t)avail * chn);
        UINT32 gotFrames = produce(fbuf.data(), avail);

        if (gotFrames > 0) {
            float* f = fbuf.data();
            const float gnow = liveControl ? g_gainLive : gain;
            const bool doGain = canGain && gnow != 1.0f;
            const bool doEq = canGain && g_eqOn && eqCh > 0;
            if (doEq && InterlockedExchange(&g_eqDirty, 0)) {       // recalcula coeficientes al cambiar
                EnterCriticalSection(&g_eqCs);
                for (int c = 0; c < eqCh; c++) for (int bnd = 0; bnd < 7; bnd++) eq_coeffs(eq[c][bnd], bnd, g_eqGainReq[bnd], (double)outRate);
                LeaveCriticalSection(&g_eqCs);
            }
            if (doGain || doEq) {                                   // ganancia (RG×vol) primero, luego EQ
                for (UINT32 i = 0; i < gotFrames; i++)
                    for (int c = 0; c < chn; c++) {
                        float s = f[i * chn + c];
                        if (doGain) s *= gnow;
                        if (doEq) for (int bnd = 0; bnd < 7; bnd++) s = eq[c][bnd].process(s);
                        f[i * chn + c] = s;
                    }
            }
            if (ditherOut) float_to_int(f, out, gotFrames, chn, intBytes, intValid, true);
            else memcpy(out, f, (size_t)gotFrames * frameBytes);
        }
        // silencio en el resto si hubo underrun / fin de stream (en live esperamos más PCM)
        if (gotFrames < avail)
            memset(out + (size_t)gotFrames * frameBytes, 0, (size_t)(avail - gotFrames) * frameBytes);
        rc->ReleaseBuffer(avail, 0);
        totalFrames += gotFrames;

        if (!liveControl && gotFrames == 0 && g_ring->isDrained() && (!rs || rs->empty())) running = false;
    }
    if (rs) { delete rs; rs = nullptr; }

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
    bool doList = false, doPlay = false, doSelftest = false, exclusive = false;
    unsigned rate = 44100, channels = 2, inRate = 0;
    float gain = 1.0f;
    std::string deviceId;

    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--list-devices") doList = true;
        else if (a == "--play") doPlay = true;
        else if (a == "--selftest") doSelftest = true;
        else if (a == "--exclusive") exclusive = true;
        else if (a == "--rate" && i + 1 < argc) rate = (unsigned)atoi(argv[++i]);
        else if (a == "--in-rate" && i + 1 < argc) inRate = (unsigned)atoi(argv[++i]);
        else if (a == "--channels" && i + 1 < argc) channels = (unsigned)atoi(argv[++i]);
        else if (a == "--gain" && i + 1 < argc) gain = (float)atof(argv[++i]);
        else if (a == "--rs-taps" && i + 1 < argc) { int t = atoi(argv[++i]); if (t >= 4 && t <= 256) RS_TAPS = t; }
        else if (a == "--device-id" && i + 1 < argc) deviceId = argv[++i];
        else if (a == "--pcm-pipe" && i + 1 < argc) g_pcmPipe = utf8_to_wide(argv[++i]);
    }

    if (doSelftest) return selftest();   // autoprueba numérica: no necesita COM ni dispositivo

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
        rc = play_stream(rate, channels, exclusive, gain, deviceId, live, inRate);
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
