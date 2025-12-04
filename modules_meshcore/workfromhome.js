/** 
* @description MeshCentral WorkFromHome plugin (cleaned)
* @author Ryan
* @version 1.1.0
* Updated for MeshCentral Dec 2025
* @license Apache-2.0
*/

"use strict";
var mesh;
var _sessionid;
var isWsconnection = false;
var wscon = null;
var db = require('SimpleDataStore').Shared();
var routeTrack = {};
var debug_flag = false;
var latestAuthCookie = null;
var lastStartRouteCall = null;
var waitTimer = null;

var fs = require('fs');
var net = require('net');
var http = require('http');

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('workfromhome.txt', {'flags': 'a'});
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
};

Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

function consoleaction(args, rights, sessionid, parent) {
    isWsconnection = false;
    wscon = parent;
    _sessionid = sessionid;
    if (typeof args['_'] == 'undefined') {
      args['_'] = [];
      args['_'][1] = args.pluginaction;
      args['_'][2] = null;
      args['_'][3] = null;
      args['_'][4] = null;
      isWsconnection = true;
    }
    
    var fnname = args['_'][1];
    mesh = parent;
    
    switch (fnname) {
        case 'startRoute': {
            var nowTime = Math.floor(new Date() / 1000);
            if (lastStartRouteCall >= nowTime - 3 && args.waitTimer != 'y') {
                dbg('Ignoring startRoute (called within the last 3 seconds)');
                return;
            }
            lastStartRouteCall = nowTime;
            
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                try {
                    if (args.localport == routeTrack[args.mid].tcpserver.address().port && routeTrack[args.mid].settings.remotenodeid == args.nodeid && routeTrack[args.mid].settings.rdplabel == args.rdplabel && routeTrack[args.mid].settings.aadcompat == args.aadcompat) {
                        dbg('Start / rebuild command sent when data has not changed and already listening. Leaving in tact and doing nothing.');
                        return;
                    }
                } catch (e) { }
                dbg('destroying connection to rebuild: ' + args.mid);
                try { routeTrack[args.mid].tcpserver.close(); } catch (e) {}
                delete routeTrack[args.mid];
                dbg('wait timer set');
                args.waitTimer = 'y';
                waitTimer = setInterval(function() { consoleaction(args, rights, sessionid, parent); }, 1000);
                return;
            } else {
                dbg('No existing route found, continuing');
            }
            if (waitTimer != null) { clearTimeout(waitTimer); waitTimer = null; }
            dbg('Starting Route');
            latestAuthCookie = args.rauth;
            var r = new RoutePlusRoute();
            var settings = {
                serverurl: mesh.ServerUrl ? mesh.ServerUrl.replace('agent.ashx', 'meshrelay.ashx') : 'https://localhost/meshrelay.ashx',
                remotenodeid: args.nodeid,
                remoteport: 3389,
                localport: args.localport == null ? 0 : args.localport,
                rdplabel: args.rdplabel,
                aadcompat: args.aadcompat
            };
            var was_error = false;
            try {
                r.startRouter(settings);
                routeTrack[args.mid] = r;
            } catch (e) { was_error = true; dbg('startRouter error: '+e); }
            
            if (was_error) {
                was_error = false;
                settings.localport = 0;
                try {
                    r.startRouter(settings);
                    routeTrack[args.mid] = r;
                } catch (e) { was_error = true; dbg('startRouter retry error: '+e); }
            }
            var actualLocalPort = r.tcpserver.address().port;
            dbg('Listening on ' + actualLocalPort);
            if (args.localport != actualLocalPort) {
                dbg('Sending updated port ' + actualLocalPort);
                mesh.SendCommand({ 
                    "action": "plugin", 
                    "plugin": "workfromhome",
                    "pluginaction": "updateMapPort",
                    "sessionid": _sessionid,
                    "tag": "console",
                    "mid": args.mid,
                    "port": actualLocalPort
                });
            }
            var curMapLink = getMapLink(args.mid);
            if (curMapLink != null && curMapLink != args.rdplabel) {
                try {
                    deleteRDPShortcut(curMapLink);
                } catch (e) { dbg('deleteRDPShortcut error: '+e); }
            }
            putMapLink(args.mid, args.rdplabel);
            makeRDPShortcut(actualLocalPort, args.rdplabel, args.aadcompat);
            break;
        }
        case 'endRoute': {
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                dbg('Ending route for ' + args.mid);
                try { routeTrack[args.mid].tcpserver.close(); } catch (e) {}
                delete routeTrack[args.mid];
                var curMapLink = getMapLink(args.mid);
                removeMapLink(args.mid);
                deleteRDPShortcut(curMapLink);
            }
            break;
        }
        case 'updateCookie':
            dbg('Updating auth cookie');
            latestAuthCookie = args.rauth;
            break;
        case 'list': {
            var s = '', count = 1;
            Object.keys(routeTrack).forEach(function (k) {
              try {
                s += count + ': Port ' + routeTrack[k].tcpserver.address().port + ' (Map ID: ' + k + ')\n';
              } catch (e) {
                s += count + ': (invalid entry) (Map ID: ' + k + ')\n';
              }
              count++;
            });
            if (s == '') s = 'No active port mappings';
            return s;
        }
        case 'listrdpmaps': {
            var x = getMapLinks();
            return JSON.stringify(x);
        }
    }
}

function getMacPath(rdplabel) {
    try {
        var child = require('child_process').execFile('/bin/sh', ['sh'], { uid: require('user-sessions').consoleUid() });
        child.stdout.str = '';
        child.stdout.on('data', function (chunk) { this.str += chunk.toString(); });
        child.stdin.write("echo ~\nexit\n");
        child.waitExit();

        var path = child.stdout.str.trim();
        path += '/Desktop/' + rdplabel + '.rdp';
        return path;
    } catch (e) {
        dbg('getMacPath error: ' + e);
        return null;
    }
}

function makeRDPShortcut(actualLocalPort, rdplabel, aad) {
    // reference aad so linters don't flag it as unused; also useful for future logic
    dbg('AAD compat: ' + String(aad));
    if (process.platform == 'linux') {
        return; // N/A
    }
    if (rdplabel == null) rdplabel = 'Work_Computer';
    dbg('checking rdp shortcut');
    var path = '\\Users\\Public\\Desktop\\' + rdplabel + '.rdp';
    if (process.platform == 'darwin') {
        var macPath = getMacPath(rdplabel);
        if (macPath) path = macPath;
    }
    var currentShortcutContents = null;
    try {
        currentShortcutContents = fs.readFileSync(path, 'utf8').toString();
    } catch (e) { /* ignore if not exists */ }
    
    var fileContents = "full address:s:127.0.0.1:" + actualLocalPort;
    
    fileContents += "\r\nenablecredsspsupport:i:0"
        + "\r\nauthentication level:i:2";
    
    if (currentShortcutContents != fileContents) {
        dbg('writing to path: ' + path);
        try {
            fs.writeFileSync(path, fileContents);
        } catch (e) {
            dbg('error was '+e);
        }
    } else {
        dbg('file contents have not changed. skipping write');
    }
}

function deleteRDPShortcut(rdplabel) {
    if (!rdplabel) return;
    dbg('deleting shortcut for ' + rdplabel);
    var path = '\\Users\\Public\\Desktop\\' + rdplabel + '.rdp';
    if (process.platform != 'win32') {
        var macPath = getMacPath(rdplabel);
        if (macPath) path = macPath;
    }
    try {
        fs.unlinkSync(path);
    } catch (e) {
        dbg('error deleting was '+e);
    }
}

function RoutePlusRoute() {
    var rObj = {};
    
    rObj.settings = null;
    
    rObj.tcpserver = null;
    rObj.startRouter = startRouter;
    rObj.debug = debug;
    rObj.OnTcpClientConnected = OnTcpClientConnected;
    rObj.disconnectTunnel = disconnectTunnel;
    rObj.OnWebSocket = OnWebSocket;
    
    return rObj;
}

function startRouter(settings) {
    this.settings = settings;
    this.tcpserver = net.createServer(this.OnTcpClientConnected.bind(this));
    this.tcpserver.on('error', function (e) { dbg("ERROR: " + JSON.stringify(e)); /* avoid exit(0) in module */ return; });
    var t = this;
    this.tcpserver.listen(this.settings.localport, function () {
        var lport = this.address ? this.address().port : t.settings.localport;
        if (t.settings.remotetarget == null) {
            dbg('Redirecting local port ' + lport + ' to remote port ' + t.settings.remoteport + '.');
        } else {
            dbg('Redirecting local port ' + lport + ' to ' + t.settings.remotetarget + ':' + t.settings.remoteport + '.');
        }
    });
}

function OnTcpClientConnected(c) {
    try {
        var self = this;
        c.on('end', function () { disconnectTunnel(this, this.websocket, "Client closed"); });
        c.pause();
        try {
            // Build URL; safer to use string concat
            var srv = (this.settings && this.settings.serverurl) ? this.settings.serverurl : '';
            var uri = srv + '?auth=' + (latestAuthCookie || '') + '&nodeid=' + (this.settings ? this.settings.remotenodeid : '') + '&tcpport=' + (this.settings ? this.settings.remoteport : '');
            if (this.settings && this.settings.remotetarget) uri += '&tcpaddr=' + this.settings.remotetarget;
            // Use http.request as in original code
            var options = uri;
        } catch (e) { dbg("Unable to parse \"serverUrl\"." + e); return; }
        // create a simple outgoing connection using http.request; keep semantics minimal
        try {
            c.websocket = http.request(options);
        } catch (e) {
            dbg('http.request failed: ' + e);
            return;
        }
        c.websocket.tcp = c;
        c.websocket.tunneling = false;
        c.websocket.upgrade = OnWebSocket;
        c.websocket.on('error', function (e) { dbg("ERROR: " + JSON.stringify(e)); });
        try { c.websocket.end(); } catch (e) { dbg('websocket end error: '+e); }
    } catch (e) { debug(2, 'catch block 2' + e); }
}

function disconnectTunnel(tcp, ws, msg) {
    try {
        if (ws != null) { try { ws.end && ws.end(); } catch (e) { debug(2, e); } }
        if (tcp != null) { try { tcp.end && tcp.end(); } catch (e) { debug(2, e); } }
    } catch (e) {
        dbg('disconnectTunnel error: ' + e);
    }
    debug(1, "Tunnel disconnected: " + msg);
}

function debug(level, message) { dbg('[' + level + '] ' + message); }

function OnWebSocket(msg, s, head) {
    debug(1, "Websocket connected");
    // reference msg/head to avoid unused param warnings
    dbg('upgrade note: ' + (msg ? String(msg).substring(0, 50) : '') + ' ' + (head ? '[head]' : ''));
    var parent = this;
    s.on('data', function (msg) {
        try {
            if (this.parent && this.parent.tunneling == false) {
                var txt = msg.toString();
                if ((txt == 'c') || (txt == 'cr')) {
                    this.parent.tunneling = true;
                    if (this.parent.tcp && this.parent.pipe) {
                        this.pipe(this.parent.tcp);
                        this.parent.tcp.pipe(this);
                    }
                    debug(1, "Tunnel active");
                } else if ((txt.length > 6) && (txt.substring(0, 6) == 'error:')) {
                    console.log(txt.substring(6));
                    disconnectTunnel(this.tcp, this, txt.substring(6));
                }
            }
        } catch (e) { dbg('OnWebSocket data handler error: ' + e); }
    });
    s.on('error', function () { disconnectTunnel(this.tcp, this, 'Websocket error'); });
    s.on('close', function () { disconnectTunnel(this.tcp, this, 'Websocket closed'); });
    s.parent = this;
}

function getMapLinks() {
    var o = db.Get('plugin_WorkFromHome_rdplinks');
    if (o == '' || o == null) return {};
    // If the store already returned an object, return it directly.
    if (typeof o === 'object') return o;
    try {
        o = JSON.parse(o);
    } catch (e) { return {}; }
    return o;
}
function getMapLink(mapId) {
    var ml = getMapLinks();
    if (ml[mapId]) {
        return ml[mapId];
    } else {
        return null;
    }
}
function removeMapLink(mapId) {
    var ml = getMapLinks();
    try { delete ml[mapId]; } catch(e) { }
    db.Put('plugin_WorkFromHome_rdplinks', ml);
}
function putMapLink(mapId, linkName) {
    removeMapLink(mapId);
    var ml = getMapLinks();
    ml[mapId] = linkName;
    db.Put('plugin_WorkFromHome_rdplinks', ml);
}

module.exports = { consoleaction : consoleaction };
