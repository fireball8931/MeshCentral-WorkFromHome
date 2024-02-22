/** 
* @description MeshCentral WorkFromHome plugin
* @author Ryan Blenis
* @copyright 
* @license Apache-2.0
*/

"use strict";
var mesh;
var obj = this;
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
var os = require('os');
var net = require('net');
var http = require('http');
var aad = true;

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('workfromhome.txt', {'flags': 'a'});
    // use {'flags': 'a'} to append and {'flags': 'w'} to erase and write a new file
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
}

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
        case 'startRoute':
            var nowTime = Math.floor(new Date() / 1000);
            // check for multiple calls. The agentCoreIsStable hook calls in rapid succession when re-checking in
            // This will avoid "stomping" on the setup process
            if (lastStartRouteCall >= nowTime - 3 && args.waitTimer != 'y') {
                dbg('Ignoring startRoute (called within the last 3 seconds)');
                return;
            }
            lastStartRouteCall = nowTime;
            
            // hold the unique mapId in memory in case a new packet is sent for recreation
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                try {
                    if (args.localport == routeTrack[args.mid].tcpserver.address().port && routeTrack[args.mid].settings.remotenodeid == args.nodeid && routeTrack[args.mid].settings.rdplabel == args.rdplabel && routeTrack[args.mid].settings.aadcompat == args.aadcompat) {
                        dbg('Start / rebuild command sent when data has not changed and already listening. Leaving in tact and doing nothing.');
                        return;
                    }
                } catch (e) { }
                dbg('destroying connection to rebuild: ' + args.mid);
                routeTrack[args.mid].tcpserver.close();
                delete routeTrack[args.mid];
                dbg('wait timer set');
                args.waitTimer = 'y';
                waitTimer = setInterval(function() { consoleaction(args, rights, sessionid, parent); }, 1000);
                return;
            } else {
                dbg('No existing route found, continuing');
            }
            if (waitTimer != null) clearTimeout(waitTimer);
            dbg('Starting Route');
            latestAuthCookie = args.rauth;
            var r = new RoutePlusRoute();
            var settings = {
                serverurl: mesh.ServerUrl.replace('agent.ashx', 'meshrelay.ashx'),
                remotenodeid: args.nodeid,
                remoteport: 3389, //args.remoteport,
                localport: args.localport == null ? 0 : args.localport,
                rdplabel: args.rdplabel,
                aadcompat: args.aadcompat
            };
            var was_error = false;
            try {
                r.startRouter(settings);
                routeTrack[args.mid] = r;
            } catch (e) { was_error = true; }
            
            if (was_error) { // probably port in use, try again with new port
                was_error = false;
                settings.localport = 0;
                try {
                    r.startRouter(settings);
                    routeTrack[args.mid] = r;
                } catch (e) { was_error = true; }
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
                } catch (e) { }
            }
            putMapLink(args.mid, args.rdplabel);
            makeRDPShortcut(actualLocalPort, args.rdplabel, args.aadcompat);
        break;
        case 'endRoute':
            if (routeTrack[args.mid] != null && routeTrack[args.mid] != 'undefined') {
                dbg('Ending route for ' + args.mid)
                routeTrack[args.mid].tcpserver.close();
                delete routeTrack[args.mid];
                var curMapLink = getMapLink(args.mid)
                removeMapLink(args.mid);
                deleteRDPShortcut(curMapLink);
            }
        break;
        case 'updateCookie':
            dbg('Updating auth cookie');
            latestAuthCookie = args.rauth;
        break;
        case 'list':
            var s = '', count = 1;
            Object.keys(routeTrack).forEach(function (k) {
              s += count + ': Port ' + routeTrack[k].tcpserver.address().port + ' (Map ID: ' + k + ')\n';
              count++;
            });
            if (s == '') s = 'No active port mappings';
            return s;
        break;
        case 'listrdpmaps':
            var x = getMapLinks();
            x = JSON.stringify(x);
            return x;
        break;
        default:
            dbg('Unknown action: '+ fnname + ' with data ' + JSON.stringify(args));
        break;
    }
}
function getMacPath(rdplabel) {
    var child = require('child_process').execFile('/bin/sh', ['sh'], { uid: require('user-sessions').consoleUid() });
    child.stdout.str = '';
    child.stdout.on('data', function (chunk) { this.str += chunk.toString(); });
    child.stdin.write("echo ~\nexit\n");
    child.waitExit();

    var path = child.stdout.str.trim();
    path += '/Desktop/' + rdplabel + '.rdp';
    return path;
}
function makeRDPShortcut(actualLocalPort, rdplabel, aad) {
    if (process.platform == 'linux') {
        return; // N/A
    }
    if (rdplabel == null) rdplabel = 'Work_Computer';
    dbg('checking rdp shortcut');
    var path = '\\Users\\Public\\Desktop\\' + rdplabel + '.rdp';
    if (process.platform == 'darwin') {
        path = getMacPath(rdplabel);
    }
    var currentShortcutContents = null;
    try {
        currentShortcutContents = fs.readFileSync(path, 'utf8').toString();
    } catch (e) { }
    
    var fileContents = "full address:s:127.0.0.1:" + actualLocalPort;
    
    if (aad) {
        fileContents += "\r\nenablecredsspsupport:i:0"
        + "\r\nauthentication level:i:2";
    }
    
    if (currentShortcutContents != fileContents) {
        dbg('writing to path: ' + path);
        try {
            fs.writeFileSync(path, fileContents);
        } catch (e) {
            dbg('error was '+e)
        }
    } else {
        dbg('file contents have not changed. skipping write');
    }
}

function deleteRDPShortcut(rdplabel) {
    if (rdplabel == null || rdplabel == 'undefined') rdplabel = 'Work_Computer';
    
    dbg('deleting shortcut')
    var path = '\\Users\\Public\\Desktop\\' + rdplabel + '.rdp';
    if (process.platform != 'win32') {
        path = getMacPath(rdplabel);
    }
    try {
        fs.unlinkSync(path);
    } catch (e) {
        dbg('error deleting was '+e)
    }
}

function RoutePlusRoute() {
    var rObj = {};
    
    rObj.settings = null;
    
    rObj.tcpserver = null;
    rObj.startRouter = startRouter;
    rObj.debug = debug;
    rObj.OnTcpClientConnected = function (c) {
        try {
            // 'connection' listener
            c.on('end', function () { disconnectTunnel(this, this.websocket, "Client closed"); });
            c.pause();
            try {
                var options = http.parseUri(rObj.settings.serverurl + '?auth=' + latestAuthCookie + '&nodeid=' + rObj.settings.remotenodeid + '&tcpport=' + rObj.settings.remoteport + (rObj.settings.remotetarget == null ? '' : '&tcpaddr=' + rObj.settings.remotetarget));
            } catch (e) { dbg("Unable to parse \"serverUrl\"." + e); return; }
            options.checkServerIdentity = this.onVerifyServer;
            options.rejectUnauthorized = false;
            c.websocket = http.request(options);
            c.websocket.tcp = c;
            c.websocket.tunneling = false;
            c.websocket.upgrade = OnWebSocket;
            c.websocket.on('error', function (e) { dbg("ERROR: " + JSON.stringify(e)); });
            c.websocket.end();
        } catch (e) { debug(2, 'catch block 2' + e); }
    };
    rObj.disconnectTunnel = disconnectTunnel;
    rObj.OnWebSocket = OnWebSocket;
    
    return rObj;
}

function startRouter(settings) {
    this.settings = settings;
    this.tcpserver = net.createServer(this.OnTcpClientConnected);
    this.tcpserver.on('error', function (e) { dbg("ERROR: " + JSON.stringify(e)); exit(0); return; });
    var t = this;
    this.tcpserver.listen(this.settings.localport, function () {
        // We started listening.
        if (t.settings.remotetarget == null) {
            dbg('Redirecting local port ' + t.lport + ' to remote port ' + t.settings.remoteport + '.');
        } else {
            dbg('Redirecting local port ' + t.lport + ' to ' + t.settings.remotetarget + ':' + t.settings.remoteport + '.');
        }
        //console.log("Press ctrl-c to exit.");

        // If settings has a "cmd", run it now.
        //process.exec("notepad.exe");
    });
}

// Called when a TCP connect is received on the local port. Launch a tunnel.

function debug(level, message) { { dbg(message); } }

// Disconnect both TCP & WebSocket connections and display a message.
function disconnectTunnel(tcp, ws, msg) {
    if (ws != null) { try { ws.end(); } catch (e) { debug(2, e); } }
    if (tcp != null) { try { tcp.end(); } catch (e) { debug(2, e); } }
    debug(1, "Tunnel disconnected: " + msg);
}

// Called when the web socket gets connected
function OnWebSocket(msg, s, head) {
    debug(1, "Websocket connected");
    s.on('data', function (msg) {
        if (this.parent.tunneling == false) {
            msg = msg.toString();
            if ((msg == 'c') || (msg == 'cr')) {
                this.parent.tunneling = true; this.pipe(this.parent.tcp); this.parent.tcp.pipe(this); debug(1, "Tunnel active");
            } else if ((msg.length > 6) && (msg.substring(0, 6) == 'error:')) {
                console.log(msg.substring(6));
                disconnectTunnel(this.tcp, this, msg.substring(6));
            }
        }
    });
    s.on('error', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket error'); });
    s.on('close', function (msg) { disconnectTunnel(this.tcp, this, 'Websocket closed'); });
    s.parent = this;
}

function getMapLinks() {
    var o = db.Get('plugin_WorkFromHome_rdplinks');
    if (o == '' || o == null) return {};
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

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };
