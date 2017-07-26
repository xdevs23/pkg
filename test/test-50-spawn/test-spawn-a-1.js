#!/usr/bin/env node

'use strict';

var spawn = require('child_process').spawn;

if (process.send) {
  require('./test-spawn-a-child.js');
  return;
}

var child = spawn(
  process.execPath, [ __filename ],
  { stdio: [ 'inherit', 'inherit', 'inherit', 'ipc' ] }
);

child.on('message', function (value) {
  console.log(value.toString());
  child.send(value);
});

child.send(2);

child.on('exit', function () {
  console.log('Child exited');
});
