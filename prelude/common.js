'use strict';

var assert = require('assert');
var path = require('path');

exports.STORE_BLOB = 0;
exports.STORE_CONTENT = 1;
exports.STORE_LINKS = 2;
exports.STORE_STAT = 3;
exports.ALIAS_AS_RELATIVE = 0;   // require("./file.js") // file or directory
exports.ALIAS_AS_RESOLVABLE = 1; // require("package")

function uppercaseDriveLetter (f) {
  if (f.slice(1, 3) !== ':\\') return f;
  return f[0].toUpperCase() + f.slice(1);
}

function removeTrailingSlashes (f) {
  if (f === '/') {
    return f; // dont remove from "/"
  }
  if (f.slice(1) === ':\\') {
    return f; // dont remove from "D:\"
  }
  var last = f.length - 1;
  while (true) {
    var char = f.charAt(last);
    if (char === '\\') {
      f = f.slice(0, -1);
      last -= 1;
    } else
    if (char === '/') {
      f = f.slice(0, -1);
      last -= 1;
    } else {
      break;
    }
  }
  return f;
}

function normalizePath (f) {
  var file = f;
  if (!(/^.:$/.test(f))) file = path.normalize(file); // 'c:' -> 'c:.'
  file = uppercaseDriveLetter(file);
  file = removeTrailingSlashes(file);
  return file;
}

exports.normalizePath = normalizePath;

exports.isPackageJson = function (file) {
  return path.basename(file) === 'package.json';
};

exports.isDotJS = function (file) {
  return path.extname(file) === '.js';
};

exports.isDotJSON = function (file) {
  return path.extname(file) === '.json';
};

exports.isDotNODE = function (file) {
  return path.extname(file) === '.node';
};

function replaceSlashes (file, slash) {
  if (/^.:\\/.test(file)) {
    if (slash === '/') {
      return file.slice(2).replace(/\\/g, '/');
    }
  } else
  if (/^\//.test(file)) {
    if (slash === '\\') {
      return 'C:' + file.replace(/\//g, '\\');
    }
  }
  return file;
}

function injectSnapshot (file) {
  if (/^.:\\/.test(file)) {
    // C:\path\to
    if (file.length === 3) file = file.slice(0, -1); // C:\
    return file[0] + ':\\snapshot' + file.slice(2);
  } else
  if (/^\//.test(file)) {
    // /home/user/project
    if (file.length === 1) file = file.slice(0, -1); // /
    return '/snapshot' + file;
  }
  return file;
}

function nonRootFromFile (f) {
  var p = path.parse(f);
  return f.slice(p.root.length).split(path.sep);
}

function denominatorLength (nr1, nr2) {
  var e = Math.min(nr1.length, nr2.length);
  if (e === 0) return 0;
  for (var i = 0; i < e; i += 1) {
    if (nr1[i] !== nr2[i]) return i;
  }
  return e;
}

function denominatorOfNonRoots (nr1, nr2) {
  var length = denominatorLength(nr1, nr2);
  if (length === nr1.length) return nr1;
  return nr1.slice(0, length);
}

exports.retrieveDenominator = function (files) {
  assert(files.length > 0);
  files = files.map(function (file) {
    return normalizePath(file);
  });

  var nr1 = nonRootFromFile(files[0]);
  for (var i = 1; i < files.length; i += 1) {
    var nr2 = nonRootFromFile(files[i]);
    nr1 = denominatorOfNonRoots(nr1, nr2);
  }

  return nr1.reduce(function (p, c) {
    return p + c.length + 1;
  }, 0);
};

function substituteDenominator (f, denominator) {
  var p = path.parse(f);
  return p.root + f.slice(p.root.length + denominator);
}

exports.snapshotify = function (file, denominator, slash) {
  var f = normalizePath(file);
  if (denominator) f = substituteDenominator(f, denominator);
  return injectSnapshot(replaceSlashes(f, slash));
};

var win32 = process.platform === 'win32';

if (win32) {
  exports.insideSnapshot = function insideSnapshot (f) {
    if (typeof f !== 'string') return false;
    var slice112 = f.slice(1, 12);
    if (slice112 === ':\\snapshot\\' ||
        slice112 === ':\\snapshot') return true;
    return false;
  };
} else {
  exports.insideSnapshot = function insideSnapshot (f) {
    if (typeof f !== 'string') return false;
    var slice010 = f.slice(0, 10);
    if (slice010 === '/snapshot/' ||
        slice010 === '/snapshot') return true;
    return false;
  };
}

exports.stripSnapshot = function (f) {
  var file = normalizePath(f);
  if (/^.:\\snapshot$/.test(file)) {
    return file[0] + ':\\**\\';
  }
  if (/^.:\\snapshot\\/.test(file)) {
    return file[0] + ':\\**' + file.slice(11);
  }
  if (/^\/snapshot$/.test(file)) {
    return '/**/';
  }
  if (/^\/snapshot\//.test(file)) {
    return '/**' + file.slice(9);
  }
  return f; // not inside
};

if (win32) {
  exports.removeUplevels = function removeUplevels (f) {
    while (true) {
      if (f.slice(0, 3) === '..\\') {
        f = f.slice(3);
      } else
      if (f === '..') {
        f = '.';
      } else {
        break;
      }
    }
    return f;
  };
} else {
  exports.removeUplevels = function removeUplevels (f) {
    while (true) {
      if (f.slice(0, 3) === '../') {
        f = f.slice(3);
      } else
      if (f === '..') {
        f = '.';
      } else {
        break;
      }
    }
    return f;
  };
}
