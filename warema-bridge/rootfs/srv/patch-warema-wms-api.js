#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function replaceExact(content, search, replacement, file, required = true) {
  if (!content.includes(search)) {
    if (required) {
      throw new Error(`Patch target not found in ${file}: ${search}`);
    }
    return { content, changed: false };
  }
  return {
    content: content.split(search).join(replacement),
    changed: true,
  };
}

function patchFile(file, replacements) {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  for (const r of replacements) {
    const out = replaceExact(content, r.search, r.replacement, file, r.required !== false);
    content = out.content;
    changed = changed || out.changed;
  }

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
    console.log(`patched ${path.basename(file)}`);
  } else {
    console.log(`no changes needed for ${path.basename(file)}`);
  }
}

function resolveDependencyBase() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'warema-wms-api', 'lib'),
    '/srv/node_modules/warema-wms-api/lib',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'wms-vb-stick.js'))) {
      return candidate;
    }
  }
  throw new Error(`warema-wms-api lib directory not found. Tried: ${candidates.join(', ')}`);
}

const base = resolveDependencyBase();
const stickFile = path.join(base, 'wms-vb-stick.js');
const usbFile = path.join(base, 'wms-vb-stick-usb.js');
const utilFile = path.join(base, 'wms-vb-wmsutil.js');

patchFile(stickFile, [
  // Crash fix seen in production logs.
  {
    search: 'stickObj.vnBlindGet(stickObj.currentWmsMsg.snr).name +',
    replacement: '((stickObj.vnBlindGet(stickObj.currentWmsMsg.snr)||{}).name||String(stickObj.currentWmsMsg.snr)) +',
  },
  // Assignment in condition bug (queue matching becomes effectively always true).
  {
    search: '( snr = "000000" )',
    replacement: '( snr === "000000" )',
  },
  {
    search: 'equals( pos, ang, moving ){',
    replacement: 'equals( pos, ang, moving ){\n\t\tvar ret = false;',
  },
  {
    search: 'else if( (typeof pos.pos) === "number" ){',
    replacement: 'else if( pos && (typeof pos.pos) === "number" ){',
  },
  // NaN check was always false.
  {
    search: 'if( (this.pos === NaN ) || ( this.ang === NaN ) ){',
    replacement: 'if( Number.isNaN(this.pos) || Number.isNaN(this.ang) ){',
  },
  // Inner completion callbacks must use stickObj, not this.
  {
    search: 'if( this.enableCmdConfirmationNotification ){',
    replacement: 'if( stickObj.enableCmdConfirmationNotification ){',
  },
  {
    search: 'if( this.enableCmdConfirmationNotification && options.cmdConfirmation ){',
    replacement: 'if( stickObj.enableCmdConfirmationNotification && options.cmdConfirmation ){',
  },
  {
    search: 'msg = stickObj.currentWmsMsg.msgType+" "+stickObj.currentWmsMsg.snr+" "+ ',
    replacement: 'var msg = stickObj.currentWmsMsg.msgType+" "+stickObj.currentWmsMsg.snr+" "+ ',
  },
  {
    search: 'nextMsgDelay = DELAY_MSG_PROC;',
    replacement: 'var nextMsgDelay = DELAY_MSG_PROC;',
  },
  {
    search: 'device = privateGetScannedDevBySnrHex( stickObj, wmsMsg.snr );',
    replacement: 'var device = privateGetScannedDevBySnrHex( stickObj, wmsMsg.snr );',
  },
  {
    search: 'counterStr = propertyStr+"Count";',
    replacement: 'var counterStr = propertyStr+"Count";',
  },
  {
    search: 'TsStr = propertyStr+"Ts";',
    replacement: 'var TsStr = propertyStr+"Ts";',
  },
  {
    search: 'as = a.type+(100000000+a.snr) // snr 8 Stellen;',
    replacement: 'var as = a.type+(100000000+a.snr) // snr 8 Stellen;',
  },
  {
    search: 'bs = b.type+(100000000+b.snr);',
    replacement: 'var bs = b.type+(100000000+b.snr);',
  },
  {
    search: 'ret=as>bs?1:(as<bs?-1:0);',
    replacement: 'var ret=as>bs?1:(as<bs?-1:0);',
  },
]);

patchFile(usbFile, [
  {
    search: 'this.status = "error";',
    replacement: 'stickObj.status = "error";',
  },
  {
    search: 'this.status = "created";',
    replacement: 'stickObj.status = "created";',
  },
  {
    search: "log.E( portPath+' error: ', err.message)",
    replacement: "log.E( `${portPath} error: ${err && err.message ? err.message : String(err)}` )",
  },
]);

patchFile(utilFile, [
  {
    search: "posEndMarker = data.lastIndexOf('}');",
    replacement: "var posEndMarker = data.lastIndexOf('}');",
  },
  {
    search: 'num = parseInt(hex, 16);',
    replacement: 'var num = parseInt(hex, 16);',
  },
  {
    search: 'ret = { cmd: "",',
    replacement: 'var ret = { cmd: "",',
  },
  {
    search: 'params  = { stickCmd: rcv };',
    replacement: 'var params  = { stickCmd: rcv };',
  },
  {
    search: 'snr     = "000000";',
    replacement: 'var snr     = "000000";',
  },
  {
    search: 'msgType = "unknown";',
    replacement: 'var msgType = "unknown";',
  },
  {
    search: 'rcvTyp = rcv.substr(8,4);',
    replacement: 'var rcvTyp = rcv.substr(8,4);',
  },
  {
    search: 'payload = rcv.substr(12);',
    replacement: 'var payload = rcv.substr(12);',
  },
  {
    search: 'parameterType = payload.substr(0,8);',
    replacement: 'var parameterType = payload.substr(0,8);',
  },
  {
    search: 'ret = new wmsMsgNew( msgType, snr, params );',
    replacement: 'var ret = new wmsMsgNew( msgType, snr, params );',
  },
  // Increase command timing to better match real-world radio latency.
  {
    search: 'case "blindGetPos"   : this.timeout =  500; this.delayAfter = 100; this.retry = 5; break;',
    replacement: 'case "blindGetPos"   : this.timeout = 1500; this.delayAfter = 250; this.retry = 1; break;',
  },
  {
    search: 'case "blindMoveToPos": this.timeout =  500; this.delayAfter = 300; this.retry = 3; break;',
    replacement: 'case "blindMoveToPos": this.timeout = 2000; this.delayAfter = 400; this.retry = 5; break;',
  },
  {
    search: 'case "blindStopMove" : this.timeout =  200; this.delayAfter =   5; this.retry = 3; break;',
    replacement: 'case "blindStopMove" : this.timeout = 1500; this.delayAfter = 100; this.retry = 5; break;',
  },
  {
    search: 'case "waveRequest"   : this.timeout =  500; this.delayAfter = 300; break;',
    replacement: 'case "waveRequest"   : this.timeout = 1500; this.delayAfter = 350; break;',
  },
  {
    search: 'case "scanRequest"   : this.timeout =  750; break;',
    replacement: 'case "scanRequest"   : this.timeout = 2000; break;',
  },
]);

console.log('warema-wms-api patching complete');
