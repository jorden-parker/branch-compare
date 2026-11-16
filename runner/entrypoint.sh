#!/bin/sh
node /runner/forward-port.mjs &
exec sh -c "$START_COMMAND"
