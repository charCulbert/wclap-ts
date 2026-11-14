// MidiEcho: sends every note and MIDI event it receives straight back out, for the raw MIDI tests. Each input event
// also marks the output on its frame: left the event's type, right its flags (so a test sees the dialect a note
// arrived in, and CLAP_EVENT_IS_LIVE). Two plug-ins: "MidiEcho" takes notes in the MIDI dialect (CLAP also
// supported), "Midi2Echo" takes only MIDI 2.
#include <clap/clap.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    clap_plugin_t plugin;
    uint32_t dialects;
    uint32_t preferred;
} Echo;

static bool init(const clap_plugin_t *p) { return true; }
static void destroy(const clap_plugin_t *p) { free(p->plugin_data); }
static bool activate(const clap_plugin_t *p, double rate, uint32_t min, uint32_t max) { return true; }
static void deactivate(const clap_plugin_t *p) {}
static bool start_processing(const clap_plugin_t *p) { return true; }
static void stop_processing(const clap_plugin_t *p) {}
static void reset(const clap_plugin_t *p) {}

static clap_process_status process(const clap_plugin_t *p, const clap_process_t *proc) {
    float *left = proc->audio_outputs[0].data32[0];
    float *right = proc->audio_outputs[0].data32[1];
    memset(left, 0, proc->frames_count * sizeof(float));
    memset(right, 0, proc->frames_count * sizeof(float));
    uint32_t count = proc->in_events->size(proc->in_events);
    for (uint32_t i = 0; i < count; i++) {
        const clap_event_header_t *e = proc->in_events->get(proc->in_events, i);
        if (e->space_id != CLAP_CORE_EVENT_SPACE_ID || e->time >= proc->frames_count) continue;
        left[e->time] = e->type;
        right[e->time] = e->flags;
        switch (e->type) {
        case CLAP_EVENT_NOTE_ON:
        case CLAP_EVENT_NOTE_OFF:
        case CLAP_EVENT_NOTE_CHOKE:
        case CLAP_EVENT_MIDI:
        case CLAP_EVENT_MIDI_SYSEX:
        case CLAP_EVENT_MIDI2: proc->out_events->try_push(proc->out_events, e); break;
        }
    }
    return CLAP_PROCESS_CONTINUE;
}

static uint32_t audio_count(const clap_plugin_t *p, bool is_input) { return is_input ? 0 : 1; }
static bool audio_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    if (is_input || index) return false;
    memset(info, 0, sizeof *info);
    strcpy(info->name, "out");
    info->channel_count = 2;
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}
static const clap_plugin_audio_ports_t audio_ports = {audio_count, audio_get};

static uint32_t note_count(const clap_plugin_t *p, bool is_input) { return 1; }
static bool note_get(const clap_plugin_t *p, uint32_t index, bool is_input, clap_note_port_info_t *info) {
    if (index) return false;
    const Echo *echo = p->plugin_data;
    memset(info, 0, sizeof *info);
    strcpy(info->name, is_input ? "in" : "out");
    info->supported_dialects = echo->dialects;
    info->preferred_dialect = echo->preferred;
    return true;
}
static const clap_plugin_note_ports_t note_ports = {note_count, note_get};

static const void *get_extension(const clap_plugin_t *p, const char *id) {
    if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audio_ports;
    if (!strcmp(id, CLAP_EXT_NOTE_PORTS)) return &note_ports;
    return NULL;
}
static void on_main_thread(const clap_plugin_t *p) {}

static const char *features[] = {CLAP_PLUGIN_FEATURE_NOTE_EFFECT, NULL};
static const clap_plugin_descriptor_t descriptors[] = {
    {CLAP_VERSION_INIT, "dev.wclap-ts.midi-echo", "MidiEcho", "wclap-ts", "", "", "", "1.0.0", "", features},
    {CLAP_VERSION_INIT, "dev.wclap-ts.midi2-echo", "Midi2Echo", "wclap-ts", "", "", "", "1.0.0", "", features},
};

static const clap_plugin_t *create(const clap_plugin_factory_t *f, const clap_host_t *host, const char *id) {
    int which = !strcmp(id, descriptors[0].id) ? 0 : !strcmp(id, descriptors[1].id) ? 1 : -1;
    if (which < 0) return NULL;
    Echo *e = calloc(1, sizeof *e);
    e->dialects = which ? CLAP_NOTE_DIALECT_MIDI2 : CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
    e->preferred = which ? CLAP_NOTE_DIALECT_MIDI2 : CLAP_NOTE_DIALECT_MIDI;
    e->plugin = (clap_plugin_t){&descriptors[which], e, init, destroy, activate, deactivate, start_processing,
                                stop_processing, reset, process, get_extension, on_main_thread};
    return &e->plugin;
}
static uint32_t count(const clap_plugin_factory_t *f) { return 2; }
static const clap_plugin_descriptor_t *get_descriptor(const clap_plugin_factory_t *f, uint32_t i) {
    return i < 2 ? &descriptors[i] : NULL;
}
static const clap_plugin_factory_t factory = {count, get_descriptor, create};

static bool entry_init(const char *path) { return true; }
static void entry_deinit(void) {}
static const void *get_factory(const char *id) { return strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &factory; }
CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, get_factory};
