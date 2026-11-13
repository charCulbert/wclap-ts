// The parameters' CLAP ids and how their values read as text, for plugin.cpp
// (its parameter table lists the ids in this order) and for an interface, if
// you add one.
// A new parameter: an id here, before P_COUNT, and a row in that table.
#pragma once
#include <locale.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum ParamId
{
    P_GAIN, // dB
    P_PAN,  // -1 left .. 1 right
    P_COUNT // how many
};

// How each unit's values read as text: for the host, through plugin.cpp's
// value_to_text and text_to_value (a parameter's unit is in its row there),
// and for an interface, if you add one, to show and read values the same way.
// A new unit: a name here, and a case in both functions.
enum ParamUnit
{
    UNIT_DECIBELS, // "-6.0 dB"
    UNIT_PAN,      // "C", "50 L", "50 R"
};

inline bool ParamValueToText (ParamUnit unit, double value, char* display, uint32_t size)
{
    switch (unit)
    {
        case UNIT_DECIBELS:
            snprintf (display, size, "%.1f dB", value);
            return true;
        case UNIT_PAN: // "C" when it rounds to the centre
            snprintf (display, size, fabs (value) < 0.005 ? "C" : value < 0 ? "%.0f L" : "%.0f R", fabs (value) * 100);
            return true;
    }
    return false;
}

// What a typed number counts in, as the value times this: a bare number, in
// the unit shown ("-6" is -6 dB; "-50" is 50 L).
// The interface types values in it too.
inline double ParamTypedScale (ParamUnit unit)
{
    return unit == UNIT_PAN ? 100 : 1; // a percent, left below 0; dB
}

// A number at the start of text, with '.' or ',' as its decimal point
// whatever locale the host set (strtod alone reads only the locale's).
inline double ParamReadNumber (const char* text, char** end)
{
    char copy[64];
    snprintf (copy, sizeof (copy), "%s", text);
    for (char* c = copy; *c; c++)
        if (*c == '.' || *c == ',')
            *c = *localeconv()->decimal_point;
    char* stop = nullptr;
    const double number = strtod (copy, &stop);
    *end = (char*) text + (stop - copy);
    return number;
}

inline bool ParamTextToValue (ParamUnit unit, const char* display, double* value)
{
    char* end = nullptr;
    const double number = ParamReadNumber (display, &end); // "-6.0 dB" reads as -6
    const bool read = end != display;
    while (*end == ' ')
        end++;
    if (read && !*end) // a bare number, as typed
        return *value = number / ParamTypedScale (unit), true;
    switch (unit) // else the text value_to_text wrote, as a host may read it back
    {
        case UNIT_DECIBELS: // "-6.0 dB"
            *value = number;
            return read && strcmp (end, "dB") == 0;
        case UNIT_PAN: // "C", "50 L", "50 R"
            *value = read ? fabs (number) / 100 * (*end == 'L' ? -1 : 1) : 0;
            return read ? strcmp (end, "L") == 0 || strcmp (end, "R") == 0 : strcmp (display, "C") == 0;
    }
    return false;
}
