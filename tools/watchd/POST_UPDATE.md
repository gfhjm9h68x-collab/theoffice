---
capability: watchd
installed-check: systemctl --user is-active watchd.service
install: tools/watchd/install.sh
---
watchd is the fleet trigger service. It lets an agent register "wake me when X
happens" (a fresh file, an HTTP condition, a shell check) and then release its
session, instead of sitting in a foreground poll loop that makes it deaf to
everything else. One cheap always-on infra process watches all registered
conditions and wakes the owning agent only when one fires, with the wake
delivery-confirmed before it stops watching. Installing it enables event-driven
"wake me when X" for every agent on this tenant. Nothing runs until you install it.
