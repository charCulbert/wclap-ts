// Spawner: a CLAP effect that starts its own thread with pthread_create, for the thread-spawn tests. activate()
// starts a worker thread that waits for work; each process() call asks it to add one to a counter, and the output
// is the counter's value divided by 1000, so a test can tell the thread ran. deactivate() stops and joins it.
#include <clap/clap.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    clap_plugin_t plugin;
    const clap_host_t *host;
    pthread_t thread;
    atomic_int running;
    atomic_int requested;
    atomic_int done;
    atomic_int started;
} Spawner;

static void *work(void *arg) {
    Spawner *s = arg;
    atomic_store(&s->started, 1);
    while (atomic_load(&s->running)) {
        int want = atomic_load(&s->requested);
        if (atomic_load(&s->done) < want) atomic_fetch_add(&s->done, 1);
        else __builtin_wasm_memory_atomic_wait32((int *)&s->requested, want, 1000000);
    }
    return NULL;
}

static bool init(const clap_plugin_t *p) { return true; }
static void destroy(const clap_plugin_t *p) { free(p->plugin_data); }

static bool activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) {
    Spawner *s = p->plugin_data;
    atomic_store(&s->running, 1);
    return pthread_create(&s->thread, NULL, work, s) == 0;
}

static void deactivate(const clap_plugin_t *p) {
    Spawner *s = p->plugin_data;
    atomic_store(&s->running, 0);
    atomic_fetch_add(&s->requested, 0);
    __builtin_wasm_memory_atomic_notify((int *)&s->requested, 1);
    pthread_join(s->thread, NULL);
}

static bool start_processing(const clap_plugin_t *p) { return true; }
static void stop_processing(const clap_plugin_t *p) {}
static void reset(const clap_plugin_t *p) {}

static clap_process_status process(const clap_plugin_t *p, const clap_process_t *proc) {
    Spawner *s = p->plugin_data;
    float value = atomic_load(&s->done) / 1000.0f;
    atomic_fetch_add(&s->requested, 1);
    __builtin_wasm_memory_atomic_notify((int *)&s->requested, 1);
    for (uint32_t c = 0; c < proc->audio_outputs[0].channel_count; c++)
        for (uint32_t i = 0; i < proc->frames_count; i++) proc->audio_outputs[0].data32[c][i] = value;
    return CLAP_PROCESS_CONTINUE;
}

static uint32_t ports_count(const clap_plugin_t *p, bool is_input) { return is_input ? 0 : 1; }
static bool ports_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    if (is_input || index) return false;
    memset(info, 0, sizeof *info);
    info->id = 0;
    strcpy(info->name, "out");
    info->channel_count = 2;
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}
static const clap_plugin_audio_ports_t ports = {ports_count, ports_get};

static const void *get_extension(const clap_plugin_t *p, const char *id) {
    return strcmp(id, CLAP_EXT_AUDIO_PORTS) ? NULL : &ports;
}
static void on_main_thread(const clap_plugin_t *p) {}

static const char *features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, NULL};
static const clap_plugin_descriptor_t descriptor = {
    CLAP_VERSION_INIT, "dev.wclap-ts.spawner", "Spawner", "wclap-ts", "", "", "", "1.0.0", "", features};

static const clap_plugin_t *create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
    if (strcmp(id, descriptor.id)) return NULL;
    Spawner *s = calloc(1, sizeof *s);
    s->host = host;
    s->plugin = (clap_plugin_t){&descriptor, s, init, destroy, activate, deactivate, start_processing,
                                stop_processing, reset, process, get_extension, on_main_thread};
    return &s->plugin;
}
static uint32_t count(const clap_plugin_factory_t *f) { return 1; }
static const clap_plugin_descriptor_t *get_descriptor(const clap_plugin_factory_t *f, uint32_t i) {
    return i ? NULL : &descriptor;
}
static const clap_plugin_factory_t factory = {count, get_descriptor, create};

static bool entry_init(const char *path) { return true; }
static void entry_deinit(void) {}
static const void *get_factory(const char *id) { return strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &factory; }
CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, get_factory};
