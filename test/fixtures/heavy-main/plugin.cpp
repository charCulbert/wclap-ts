// Laid out as nakst's CLAP tutorial: https://nakst.gitlab.io/tutorial/clap-part-1.html
//
// Heavy Main: stereo gain and pan with no interface of its own. Hosts
// show their own controls for its parameters.
//
// This file is the whole CLAP plugin, in the same sections, in the same order,
// as every example's plugin.cpp, so comparing two shows only what differs:
//   Descriptor and features
//   Audio ports
//   Note ports
//   Parameters (the CLAP params extension)
//   Recalled settings (saved with the plugin, but not CLAP parameters)
//   Latency and tail
//   Process: events, then DSP
//   State: parameters and settings
//   UI connection (the only section the webview and chardraw examples differ in)
//   The plugin: CLAP's callbacks, and what entry.cpp needs
// Every example has every extension, so a plugin becomes another kind by
// filling in bodies; an unused one returns 0 or false and says what goes there.
//
// params.h numbers the parameters and reads their values as text, for this file
// and an interface, if you add one. entry.cpp is the entry point that makes the
// plugin. libs/core holds the CBOR codec its state uses (messages.h).
#include "clap/clap.h"
#include "clap/events.h"
#include "clap/ext/audio-ports.h"
#include "clap/ext/note-ports.h"
#include "clap/ext/params.h"
#include "clap/ext/state.h"
#include "clap/ext/latency.h"
#include "clap/ext/tail.h"
#include "clap/ext/gui.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <atomic>
#include <cmath>
#include <vector>
#include "core/messages.h"
#include "params.h" // the parameters' ids, and their values as text

static_assert (std::atomic<float>::is_always_lock_free);
static_assert (std::atomic<bool>::is_always_lock_free);

struct MyPlugin
{
    clap_plugin_t plugin;
    const clap_host_t* host;
    const clap_host_params_t* hostParams;
    float sampleRate;

    // Parameter values live twice: `parameters` on the audio thread, and
    // `mainParameters` on the main thread (for get_value and the state), each
    // with a flag saying the other thread has news for it.
    std::atomic<float> parameters[P_COUNT], mainParameters[P_COUNT];
    std::atomic<bool> changed[P_COUNT], mainChanged[P_COUNT];

    // A wavetable bank, rebuilt on the main thread whenever a state loads (the heavy main-thread work
    // under test), handed to the audio thread through `pendingBank`; the audio thread hands the one it
    // replaced back through `retiredBank` for the main thread to free.
    std::atomic<float*> pendingBank { nullptr }, retiredBank { nullptr };
    float* bank = nullptr; // the audio thread's
    uint32_t phase = 0;
};

static constexpr uint32_t bankTables = 64, tableSize = 2048, bankPartials = 256;

static float* PluginBuildBank()
{
    float* bank = new float[bankTables * tableSize]();
    for (uint32_t t = 0; t < bankTables; t++)
        for (uint32_t k = 1; k <= bankPartials; k++)
        {
            const float amplitude = powf ((float) k, -1.0f - (float) t / bankTables);
            for (uint32_t i = 0; i < tableSize; i++)
                bank[t * tableSize + i] += amplitude * sinf (6.2831853f * (float) (k * i % tableSize) / tableSize);
        }
    return bank;
}

// The extension tables refer to these before their definitions further down.
static void PluginProcessEvent (MyPlugin* plugin, const clap_event_header_t* event);
static void PluginSyncMainToAudio (MyPlugin* plugin, const clap_output_events_t* out);
static bool PluginSyncAudioToMain (MyPlugin* plugin);
static double PluginGetValue (MyPlugin* plugin, uint32_t i);

// ---- Descriptor and features ----------------------------------------------

static const char* const pluginFeatures[] = {
    CLAP_PLUGIN_FEATURE_AUDIO_EFFECT,
    CLAP_PLUGIN_FEATURE_UTILITY,
    CLAP_PLUGIN_FEATURE_STEREO,
    nullptr,
};

static const clap_plugin_descriptor_t pluginDescriptor = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "com.charlieculbert.heavy-main",
    .name = "Heavy Main",
    .vendor = "Charlie Culbert",
    .url = "",
    .manual_url = "",
    .support_url = "",
    .version = "1.0.0",
    .description = "Stereo gain and pan, with no interface of its own.",
    .features = pluginFeatures,
};

// ---- Audio ports ----------------------------------------------------------

// One stereo input and one stereo output. (An instrument has no input: count
// returns isInput ? 0 : 1.)
static const clap_plugin_audio_ports_t extensionAudioPorts = {
    .count = [] (const clap_plugin_t* plugin, bool isInput) -> uint32_t { return 1; },

    .get = [] (const clap_plugin_t* plugin, uint32_t index, bool isInput, clap_audio_port_info_t* info) -> bool {
        if (index)
            return false;
        info->id = 0;
        info->channel_count = 2;
        info->flags = CLAP_AUDIO_PORT_IS_MAIN;
        info->port_type = CLAP_PORT_STEREO;
        info->in_place_pair = CLAP_INVALID_ID;
        snprintf (info->name, sizeof (info->name), "%s", isInput ? "Audio Input" : "Audio Output");
        return true;
    },
};

// ---- Note ports -----------------------------------------------------------

// Count 0: an effect. An instrument returns isInput ? 1 : 0 here, for this
// one note input taking CLAP note events or MIDI.
static const clap_plugin_note_ports_t extensionNotePorts = {
    .count = [] (const clap_plugin_t* plugin, bool isInput) -> uint32_t { return 0; },

    .get = [] (const clap_plugin_t* plugin, uint32_t index, bool isInput, clap_note_port_info_t* info) -> bool {
        if (!isInput || index)
            return false;
        info->id = 0;
        info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
        info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
        snprintf (info->name, sizeof (info->name), "%s", "Note Input");
        return true;
    },
};

// ---- Parameters -----------------------------------------------------------

// Each parameter, in the order of its id (params.h): what get_info tells the
// host, and what the rest of this file reads. The key is what the value is
// saved under in the state: never change one once a version is released, or
// the values people saved are lost. The name is only what the host shows, and
// can change freely.
struct Param
{
    clap_id id;
    const char* key;
    const char* name;
    double min, max, defaultValue;
    clap_param_info_flags flags;
    ParamUnit unit;
};
static constexpr Param paramTable[] = {
    { P_GAIN, "gain", "Gain", -60.0, 12.0, 0.0, CLAP_PARAM_IS_AUTOMATABLE, UNIT_DECIBELS },
    { P_PAN, "pan", "Pan", -1.0, 1.0, 0.0, CLAP_PARAM_IS_AUTOMATABLE, UNIT_PAN },
};
static_assert (std::size (paramTable) == P_COUNT, "a row for each id in params.h");
static_assert (
    [] {
        for (uint32_t i = 0; i < P_COUNT; i++)
            if (paramTable[i].id != i)
                return false;
        return true;
    }(),
    "the rows in the order of their ids");

static const clap_plugin_params_t extensionParams = {
    .count = [] (const clap_plugin_t* plugin) -> uint32_t { return P_COUNT; },

    .get_info = [] (const clap_plugin_t* _plugin, uint32_t index, clap_param_info_t* information) -> bool {
        if (index >= P_COUNT)
            return false;
        const Param& param = paramTable[index];
        memset (information, 0, sizeof (clap_param_info_t));
        information->id = param.id;
        information->flags = param.flags;
        information->min_value = param.min;
        information->max_value = param.max;
        information->default_value = param.defaultValue;
        snprintf (information->name, sizeof (information->name), "%s", param.name);
        return true;
    },

    .get_value = [] (const clap_plugin_t* _plugin, clap_id id, double* value) -> bool {
        MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;
        uint32_t i = (uint32_t) id;
        if (i >= P_COUNT)
            return false;

        *value = PluginGetValue (plugin, i);
        return true;
    },

    .value_to_text = [] (const clap_plugin_t* _plugin, clap_id id, double value, char* display, uint32_t size) -> bool {
        return id < P_COUNT && ParamValueToText (paramTable[id].unit, value, display, size);
    },

    .text_to_value = [] (const clap_plugin_t* _plugin, clap_id id, const char* display, double* value) -> bool {
        return id < P_COUNT && ParamTextToValue (paramTable[id].unit, display, value);
    },

    .flush =
        [] (const clap_plugin_t* _plugin, const clap_input_events_t* in, const clap_output_events_t* out) {
            MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;
            const uint32_t eventCount = in->size (in);

            // For parameters that have been modified by the main thread, send CLAP_EVENT_PARAM_VALUE events to the host.
            PluginSyncMainToAudio (plugin, out);

            // Process events sent to our plugin from the host.
            for (uint32_t eventIndex = 0; eventIndex < eventCount; eventIndex++)
            {
                PluginProcessEvent (plugin, in->get (in, eventIndex));
            }
        },
};

// The current value on the main thread: the audio thread's value, unless the
// main thread has changed it since. get_value and the UI both use this.
static double PluginGetValue (MyPlugin* plugin, uint32_t i)
{
    return plugin->mainChanged[i] ? plugin->mainParameters[i].load() : plugin->parameters[i].load();
}

// The main thread's edits (a state loaded) to the audio thread, and to the
// host as events: in process, or flush when the host isn't processing.
static void PluginSyncMainToAudio (MyPlugin* plugin, const clap_output_events_t* out)
{
    for (uint32_t i = 0; i < P_COUNT; i++)
    {
        if (plugin->mainChanged[i].exchange (false, std::memory_order_acquire))
        {
            const float value = (plugin->mainParameters[i].load (std::memory_order_relaxed));
            plugin->parameters[i].store (value, std::memory_order_relaxed);
            clap_event_param_value_t event = {};
            event.header.size = sizeof (event);
            event.header.time = 0;
            event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
            event.header.type = CLAP_EVENT_PARAM_VALUE;
            event.header.flags = 0;
            event.param_id = i;
            event.cookie = NULL;
            event.note_id = -1;
            event.port_index = -1;
            event.channel = -1;
            event.key = -1;
            event.value = value;
            out->try_push (out, &event.header);
        }
    }
}

// The host's changes (on the audio thread) to the main thread.
static bool PluginSyncAudioToMain (MyPlugin* plugin)
{
    bool anyChanged = false;

    for (uint32_t i = 0; i < P_COUNT; i++)
    {
        // An edit from the main thread not yet sent to the audio thread is
        // newer than the host's value: keep it.
        if (plugin->changed[i].exchange (false, std::memory_order_acquire)
            && !plugin->mainChanged[i].load (std::memory_order_acquire))
        {
            plugin->mainParameters[i].store (
                plugin->parameters[i].load (std::memory_order_relaxed), std::memory_order_relaxed);
            anyChanged = true;
        }
    }

    return anyChanged;
}

// ---- Recalled settings ----------------------------------------------------

// None: with no window there's nothing to recall. (The examples with an
// interface keep their window's size here, save it with the state, and call
// the host's clap.state mark_dirty when it changes: their section shows how
// to add a setting.)

// ---- Latency and tail -----------------------------------------------------

// 0: the output isn't delayed. (A lookahead returns its delay in samples.)
static const clap_plugin_latency_t extensionLatency = {
    .get = [] (const clap_plugin_t* plugin) -> uint32_t { return 0; },
};

// 0: silence in, silence out at once. (A reverb or delay returns how many
// samples it rings on for.)
static const clap_plugin_tail_t extensionTail = {
    .get = [] (const clap_plugin_t* plugin) -> uint32_t { return 0; },
};

// ---- Process: events, then DSP --------------------------------------------

// An effect ignores notes. An instrument starts a voice here.
static void PluginNoteOn (MyPlugin* plugin, int32_t noteID, int16_t channel, int16_t key) {}

// An effect ignores notes. An instrument releases the voices the note event
// names here (-1 in a field matches any), at once for a choke.
static void PluginNoteOff (MyPlugin* plugin, int32_t noteID, int16_t channel, int16_t key, bool choke) {}

static void PluginProcessEvent (MyPlugin* plugin, const clap_event_header_t* event)
{
    if (event->space_id == CLAP_CORE_EVENT_SPACE_ID)
    {
        if (event->type == CLAP_EVENT_NOTE_ON || event->type == CLAP_EVENT_NOTE_OFF
            || event->type == CLAP_EVENT_NOTE_CHOKE)
        {
            const clap_event_note_t* note = (const clap_event_note_t*) event;
            if (event->type == CLAP_EVENT_NOTE_ON)
                PluginNoteOn (plugin, note->note_id, note->channel, note->key);
            else
                PluginNoteOff (plugin, note->note_id, note->channel, note->key, event->type == CLAP_EVENT_NOTE_CHOKE);
        }
        else if (event->type == CLAP_EVENT_MIDI)
        {
            const uint8_t* data = ((const clap_event_midi_t*) event)->data;
            const uint8_t status = data[0] & 0xF0, channel = data[0] & 0x0F;
            if (status == 0x90 && data[2] > 0)
                PluginNoteOn (plugin, -1, channel, data[1]);
            else if (status == 0x80 || status == 0x90)
                PluginNoteOff (plugin, -1, channel, data[1], false);
        }
        else if (event->type == CLAP_EVENT_PARAM_VALUE)
        {
            const clap_event_param_value_t* valueEvent = (const clap_event_param_value_t*) event;
            if (valueEvent->param_id >= P_COUNT)
                return;
            uint32_t i = (uint32_t) valueEvent->param_id;
            // Kept in range, whatever the host sends.
            const Param& param = paramTable[i];
            const double value =
                valueEvent->value == valueEvent->value ? valueEvent->value : param.defaultValue; // NaN: the default
            plugin->parameters[i].store ((float) fmin (fmax (value, param.min), param.max), std::memory_order_relaxed);
            plugin->changed[i].store (true, std::memory_order_release);
        }
    }
}

// The DSP, from frame start up to end. input is nullptr in an instrument.
static void PluginRenderAudio (
    MyPlugin* plugin, uint32_t start, uint32_t end, float* const* input, float* const* output)
{
    const float gain = powf (10.0f, plugin->parameters[P_GAIN].load (std::memory_order_relaxed) / 20.0f);
    const float pan = plugin->parameters[P_PAN].load (std::memory_order_relaxed);
    // A balance control: turning towards one side lowers the other.
    const float left = gain * fminf (1.0f, 1.0f - pan), right = gain * fminf (1.0f, 1.0f + pan);

    for (uint32_t index = start; index < end; index++)
    {
        output[0][index] = input[0][index] * left;
        output[1][index] = input[1][index] * right;
    }
}

// An effect has no voices. An instrument tells the host here which have
// finished (CLAP_EVENT_NOTE_END), so it can free their notes.
static void PluginEndFinishedVoices (MyPlugin* plugin, const clap_output_events_t* out, uint32_t time) {}

static clap_process_status PluginProcess (MyPlugin* plugin, const clap_process_t* process)
{
    PluginSyncMainToAudio (plugin, process->out_events);

    assert (process->audio_outputs_count == 1);
    float* const* input = process->audio_inputs_count ? process->audio_inputs[0].data32 : nullptr;
    float* const* output = process->audio_outputs[0].data32;

    // Events at their time in the block, the audio between them.
    const uint32_t frameCount = process->frames_count;
    const uint32_t inputEventCount = process->in_events->size (process->in_events);
    uint32_t eventIndex = 0;
    uint32_t nextEventFrame = inputEventCount ? 0 : frameCount;

    for (uint32_t i = 0; i < frameCount;)
    {
        while (eventIndex < inputEventCount && nextEventFrame == i)
        {
            const clap_event_header_t* event = process->in_events->get (process->in_events, eventIndex);

            if (event->time != i)
            {
                nextEventFrame = event->time;
                break;
            }

            PluginProcessEvent (plugin, event);
            eventIndex++;

            if (eventIndex == inputEventCount)
            {
                nextEventFrame = frameCount;
                break;
            }
        }

        PluginRenderAudio (plugin, i, nextEventFrame, input, output);
        i = nextEventFrame;
    }
    PluginEndFinishedVoices (plugin, process->out_events, frameCount ? frameCount - 1 : 0);

    if (float* bank = plugin->pendingBank.exchange (nullptr, std::memory_order_acquire))
    {
        plugin->retiredBank.store (plugin->bank, std::memory_order_release); // leaks one if two loads land in one block
        plugin->bank = bank;
    }
    if (plugin->bank)
        for (uint32_t i = 0; i < frameCount; i++)
        {
            const float x = 0.1f * plugin->bank[plugin->phase];
            plugin->phase = (plugin->phase + 5) % tableSize;
            output[0][i] += x;
            output[1][i] += x;
        }

    return CLAP_PROCESS_CONTINUE;
}

// ---- State: parameters and settings ---------------------------------------

// A CBOR map (core/messages.h) of each parameter's value by key, the
// settings, and a version, so later versions can add to it and still read
// this one.
static const clap_plugin_state_t extensionState = {
    .save = [] (const clap_plugin_t* _plugin, const clap_ostream_t* stream) -> bool {
        MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;

        // Synchronize any changes from the audio thread (that is, parameter values sent to us by the host)
        // before we save the state of the plugin.
        PluginSyncAudioToMain (plugin);

        core::Value::Map state { { "version", 1 } };
        for (uint32_t i = 0; i < P_COUNT; i++)
        {
            const Param& param = paramTable[i];
            state[param.key] = (double) plugin->mainParameters[i].load (std::memory_order_relaxed);
        }
        const auto bytes = core::encode (state);
        const unsigned char* data = bytes.data();
        uint64_t remaining = bytes.size();
        while (remaining)
        {
            const int64_t written = stream->write (stream, data, remaining);
            if (written <= 0)
                return false;
            data += written;
            remaining -= (uint64_t) written;
        }
        return true;
    },

    .load = [] (const clap_plugin_t* _plugin, const clap_istream_t* stream) -> bool {
        MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;

        std::vector<unsigned char> bytes;
        unsigned char buffer[256];
        for (int64_t read; (read = stream->read (stream, buffer, sizeof (buffer))) > 0;)
        {
            bytes.insert (bytes.end(), buffer, buffer + read);
            if (bytes.size() > core::maxMessageBytes)
                return false;
        }
        auto state = core::decode (bytes.data(), bytes.size());
        if (!state || (*state)["version"].number() < 1)
            return false;

        // Anything missing from the state keeps its default.
        for (uint32_t i = 0; i < P_COUNT; i++)
        {
            const Param& param = paramTable[i];
            const double value = (*state)[param.key].number (param.defaultValue);
            plugin->mainParameters[i].store (
                (float) fmin (fmax (value, param.min), param.max), std::memory_order_relaxed);
            plugin->mainChanged[i].store (true, std::memory_order_release);
        }
        if (plugin->hostParams)
            plugin->hostParams->rescan (plugin->host, CLAP_PARAM_RESCAN_VALUES);

        delete[] plugin->retiredBank.exchange (nullptr, std::memory_order_acquire);
        delete[] plugin->pendingBank.exchange (PluginBuildBank(), std::memory_order_acq_rel);
        return true;
    },
};

// ---- UI connection --------------------------------------------------------

// No interface: is_api_supported says no to every window, so hosts show
// their own controls for the parameters. An example with an interface
// creates, sizes and shows its window in these, and adds the extensions its
// view needs (clap.webview, and clap.timer-support for Linux).
static const clap_plugin_gui_t extensionGui = {
    .is_api_supported = [] (const clap_plugin_t* _plugin, const char* api, bool isFloating) -> bool { return false; },
    .get_preferred_api = [] (const clap_plugin_t* _plugin, const char** api, bool* isFloating) -> bool {
        return false;
    },
    .create = [] (const clap_plugin_t* _plugin, const char* api, bool isFloating) -> bool { return false; },
    .destroy = [] (const clap_plugin_t* _plugin) {},
    .set_scale = [] (const clap_plugin_t* _plugin, double scale) -> bool { return false; },
    .get_size = [] (const clap_plugin_t* _plugin, uint32_t* width, uint32_t* height) -> bool { return false; },
    .can_resize = [] (const clap_plugin_t* _plugin) -> bool { return false; },
    .get_resize_hints = [] (const clap_plugin_t* _plugin, clap_gui_resize_hints_t* hints) -> bool { return false; },
    .adjust_size = [] (const clap_plugin_t* _plugin, uint32_t* width, uint32_t* height) -> bool { return false; },
    .set_size = [] (const clap_plugin_t* _plugin, uint32_t width, uint32_t height) -> bool { return false; },
    .set_parent = [] (const clap_plugin_t* _plugin, const clap_window_t* window) -> bool { return false; },
    .set_transient = [] (const clap_plugin_t* _plugin, const clap_window_t* window) -> bool { return false; },
    .suggest_title = [] (const clap_plugin_t* _plugin, const char* title) {},
    .show = [] (const clap_plugin_t* _plugin) -> bool { return false; },
    .hide = [] (const clap_plugin_t* _plugin) -> bool { return false; },
};

// ---- The plugin -----------------------------------------------------------

static const clap_plugin_t pluginClass = {
    .desc = &pluginDescriptor,
    .plugin_data = nullptr,

    .init = [] (const clap_plugin* _plugin) -> bool {
        MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;

        plugin->hostParams = (const clap_host_params_t*) plugin->host->get_extension (plugin->host, CLAP_EXT_PARAMS);

        for (uint32_t i = 0; i < P_COUNT; i++)
        {
            const Param& param = paramTable[i];
            float defaultValue = (float) param.defaultValue;
            plugin->mainParameters[i].store (defaultValue, std::memory_order_relaxed);
            plugin->parameters[i].store (defaultValue, std::memory_order_relaxed);
        }

        return true;
    },

    .destroy = [] (const clap_plugin* _plugin) { delete (MyPlugin*) _plugin->plugin_data; },

    .activate = [] (const clap_plugin* _plugin, double sampleRate, uint32_t minimumFramesCount,
                    uint32_t maximumFramesCount) -> bool {
        MyPlugin* plugin = (MyPlugin*) _plugin->plugin_data;
        plugin->sampleRate = (float) sampleRate;
        return true;
    },

    .deactivate = [] (const clap_plugin* _plugin) {},

    .start_processing = [] (const clap_plugin* _plugin) -> bool { return true; },

    .stop_processing = [] (const clap_plugin* _plugin) {},

    .reset = [] (const clap_plugin* _plugin) {}, // nothing to clear: gain and pan have no memory

    .process = [] (const clap_plugin* _plugin, const clap_process_t* process) -> clap_process_status {
        return PluginProcess ((MyPlugin*) _plugin->plugin_data, process);
    },

    .get_extension = [] (const clap_plugin* plugin, const char* id) -> const void* {
        if (0 == strcmp (id, CLAP_EXT_AUDIO_PORTS))
            return &extensionAudioPorts;
        if (0 == strcmp (id, CLAP_EXT_NOTE_PORTS))
            return &extensionNotePorts;
        if (0 == strcmp (id, CLAP_EXT_PARAMS))
            return &extensionParams;
        if (0 == strcmp (id, CLAP_EXT_LATENCY))
            return &extensionLatency;
        if (0 == strcmp (id, CLAP_EXT_TAIL))
            return &extensionTail;
        if (0 == strcmp (id, CLAP_EXT_STATE))
            return &extensionState;
        if (0 == strcmp (id, CLAP_EXT_GUI))
            return &extensionGui;
        return nullptr;
    },

    // Asked for with request_callback: nothing does here. (An interface is
    // sent the host's parameter changes, and the meter, from here.)
    .on_main_thread = [] (const clap_plugin* _plugin) {},
};

// What entry.cpp needs.
const clap_plugin_descriptor_t* getPluginDescriptor()
{
    return &pluginDescriptor;
}

const clap_plugin_t* createPlugin (const clap_host_t* host)
{
    MyPlugin* plugin = new MyPlugin();
    plugin->host = host;
    plugin->plugin = pluginClass;
    plugin->plugin.plugin_data = plugin;
    return &plugin->plugin;
}
