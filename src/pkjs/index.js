/*jslint
    eqeq: true,
    vars: true,
    unparam: true
*/
/*global
    Pebble: false,
    window: false,
    console: false,
    navigator: false,
    XMLHttpRequest: false
*/

var _ = require('underscore');
var sunriset = require('./sunriset.js');
var colors = require('./colors.js');
var keys = require('message_keys');
var Clay = require('pebble-clay');
var clayConfig = require('./config.js');
var clayCustomFunc = require('./custom-clay.js');
var Preview = require('pebble-clay-preview-component');
var previewTemplate = require('raw!../../resources/data/preview.svg'); 
var previewStyle = require('raw!../../resources/data/preview.css'); 
var previewComponent = new Preview(previewTemplate, previewStyle); 

var clay = new Clay(clayConfig, clayCustomFunc, { autoHandleEvents: false });
clay.registerComponent(previewComponent);

var CITIES = {
    'vancouver':   { latitude: 49.25,   longitude: -123.12, timezone: -420 },
    'toronto':     { latitude: 43.65,   longitude: -79.38,  timezone: -240 },
    'montreal':    { latitude: 45.50,   longitude: -73.57,  timezone: -240 },
    'newyork':     { latitude: 40.71,   longitude: -74.01,  timezone: -240 },
    'losangeles':  { latitude: 34.05,   longitude: -118.24, timezone: -420 },
    'chicago':     { latitude: 41.88,   longitude: -87.63,  timezone: -300 },
    'london':      { latitude: 51.51,   longitude: -0.13,   timezone: 60  },
    'paris':       { latitude: 48.85,   longitude: 2.35,    timezone: 120 },
    'tokyo':       { latitude: 35.68,   longitude: 139.69,  timezone: 540 },
    'sydney':      { latitude: -33.87,  longitude: 151.21,  timezone: 600 }
};

function locationMessage(pos) {
    'use strict';
    var coordinates = pos.coords,
        now = new Date(),
        sun = sunriset.sun_rise_set(now, coordinates.longitude, coordinates.latitude),
        message = {
            'LATITUDE': coordinates.latitude * 0x10000,
            'LONGITUDE': coordinates.longitude * 0x10000,
            'TIMEZONE': pos.timezone,
            'TIMESTAMP': pos.timestamp / 1000,
            'SUNRISE': sun.rise * 60,
            'SUNSET': sun.set * 60,
            'SUNSOUTH': sun.south * 60,
            'SUNSTAT': sun.status
        };
    //console.log('location: ' + JSON.stringify(pos, null, 2));
    //console.log('sun: ' + JSON.stringify(sun, null, 2));
    //console.log('message: ' + JSON.stringify(message, null, 2));
    return message;
}

function sendLocation(pos) {
    'use strict';
    var message = locationMessage(pos);
    Pebble.sendAppMessage(message, function (result) {
        //console.log('ack tx ' + result.data.transactionId);
    }, function (result) {
        console.log(result.data.error.message);
    });
}

function locationSuccess(pos) {
    'use strict';
    var offsetMinutes = new Date().getTimezoneOffset(); // negative of UTC offset
    pos.timezone = -offsetMinutes;
    console.log('GPS fix: lat=' + pos.coords.latitude + ' lon=' + pos.coords.longitude + ' tz=' + pos.timezone + ' min');
    // Remember the last good fix so a later failure can fall back to it
    // rather than leaving the watch stuck on stale data ("hard lock").
    storeObject('lastfix', {
        timestamp: Date.now(),
        timezone: pos.timezone,
        coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
        }
    });
    sendLocation(pos);
}

function locationError(positionError) {
    'use strict';
    console.warn('position error: ', positionError && positionError.message);
    // Fall back to the last good fix so the watch still receives a fresh
    // update (sun times recompute for today) instead of locking up.
    var last = retrieveObject('lastfix', null);
    if (last) {
        last.timestamp = Date.now();
        console.log('GPS failed; sending last known fix as fallback');
        sendLocation(last);
    }
}

function locationRequest() {
    'use strict';
    var locationOptions = {
            'enableHighAccuracy': false,    // coarse location is ample for sun times and far more reliable
            'timeout': 15 * 1000,           // 15 seconds (in milliseconds)
            'maximumAge': 30 * 60 * 1000    // accept a fix up to 30 minutes old
        };
    if (navigator.geolocation) {
        //console.log('get current position');
        navigator.geolocation.getCurrentPosition(locationSuccess, locationError, locationOptions);
    } else {
        console.log('location services not available');
    }
}

function locationOverride(locopts) {
    if (locopts && !locopts.automatic) {
        var pos = {
            timestamp: Date.now(),
            timezone: parseInt(locopts.timezone),
            coords: {
                latitude: parseFloat(locopts.latitude),
                longitude: parseFloat(locopts.longitude),
                accuracy: 0
            }
        };
        return pos;
    }
    return null;
}

/**
 * Scan over the config and run the callback if the testFn resolves to true
 * @private
 * @param {Clay~ConfigItem|Array} item
 * @param {_scanConfig_testFn} testFn
 * @param {_scanConfig_callback} callback
 * @return {void}
 */
function _scanConfig(item, testFn, callback) {
    if (Array.isArray(item)) {
        item.forEach(function (item) {
            _scanConfig(item, testFn, callback);
        });
    } else if (item.type === 'section') {
        _scanConfig(item.items, testFn, callback);
    } else if (testFn(item)) {
        callback(item);
    }
}

function loadCustomPresets() {

    var customColorPresets = retrieveObject('custom-presets', {});
    var paletteSelector;
    _scanConfig(clay.config, function(item) {
        return item.messageKey === 'PALETTE'; 
    }, function(item) {
        paletteSelector = item;
    });

    console.log('apply custom presets: ' + JSON.stringify(customColorPresets, null, 2));

    for (var customPresetKey in customColorPresets) {
        var selectorOption = _.findWhere(paletteSelector.options, { writable: true, value: customPresetKey });
        if (selectorOption) {
            console.log('preset[' + customPresetKey + '] <- ' + JSON.stringify(customColorPresets[customPresetKey]));
            selectorOption.colors = customColorPresets[customPresetKey]; 
        } else {
            console.log('no such preset[' + customPresetKey + ']');
        }
    }

}

function updateCustomPresets(modifiedPresets) {
    var customPresets = retrieveObject('custom-presets', {});
    _.extend(customPresets, modifiedPresets);
    console.log('updated custom presets: ' + JSON.stringify(customPresets, null, 2));
    storeObject('custom-presets', customPresets);
}

// --------------------------------------------------------------------------
//
// --------------------------------------------------------------------------

Pebble.addEventListener('ready', function () {
    'use strict';

    var locopts = retrieveObject('location', null),
        pos = locationOverride(locopts);
    if (pos) {
        sendLocation(pos);
    } else {
        locationRequest();
    }
});

Pebble.addEventListener('showConfiguration', function(e) {
    loadCustomPresets();
    Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (e) {
    if (e && !e.response) {
        return;
    }

    var k,
        dict = clay.getSettings(e.response),
        userData = clay.getUserData(e.response),
        cityKey = dict['city-select'] || 'vancouver',
        cityData = CITIES[cityKey] || CITIES['vancouver'],
        message = {
            'BLUETOOTH': parseInt(dict[keys.BLUETOOTH], 10),
            'BATTERY': !!dict[keys.BATTERY],
            'PALETTE': []
        },
        locopts = {
            automatic: !!dict[keys.LOCATION],
            latitude:  cityData.latitude,
            longitude: cityData.longitude,
            timezone:  cityData.timezone  // selected city's UTC offset (minutes). Auto/GPS uses phone offset in locationSuccess()
        };

    //console.log('keys: ' + JSON.stringify(keys, null, 2));
    //console.log('dict: ' + JSON.stringify(dict, null, 2));
    //console.log('locopts: ' + JSON.stringify(locopts, null, 2));
    console.log('userData: ' + JSON.stringify(userData, null, 2));
    updateCustomPresets(userData.modifiedPresets);

    storeObject('location', locopts);
    var locpos = locationOverride(locopts);
    if (locpos) {
        var locmsg = locationMessage(locpos);
        _.extendOwn(message, locmsg);
    } else {
        locationRequest();
    }

    for (k = 0; k < 12; ++k) {
        message.PALETTE.push(colors.eightBitColorFromInt(dict[keys.COLORS + k]));
    }

    console.log(JSON.stringify(message, null, 2));

    Pebble.sendAppMessage(message, function(e) {
        //console.log('Sent config data to Pebble');
    }, function(e) {
        console.log('Failed to send config data!');
        console.log(JSON.stringify(e));
    });
});

// ---------------------------------------------------------------------------
// Local Storage
// ---------------------------------------------------------------------------

function storeObject(name, value) {
    window.localStorage.setItem(name, JSON.stringify(value));
}

function retrieveObject(name, defaultValue) {
    var encodedValue = window.localStorage.getItem(name),
        value;
    if (encodedValue) {
        try {
            value = JSON.parse(encodedValue);
            //console.log(name + ': ' + JSON.stringify(value, null, 2));
        } catch (ex) {
            console.log('clear corrupted ' + name + ': ' + encodedValue);
            window.localStorage.removeItem(name);
            value = defaultValue;
        }
    } else {
        value = defaultValue;
    }
    return value;
}
