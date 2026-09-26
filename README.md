# MKE Tour — Doors Open Milwaukee 2026 route

A static walking-route planner for 11 downtown Doors Open Milwaukee stops (Sep 26–27, 2026), laid out like a phone app: Map, List and My Plan tabs, with a detail page for each building.

- Every photo, description, accessibility and photography note comes from the building's own page on historicmilwaukee.org (`info.js`, images loaded from their server)

- Leaflet map with real walking routes between stops (precomputed from OpenStreetMap / OSRM foot routing, stored in `data.js`)
- Drag (or ▲/▼) to reorder; the map, walk times, distances and arrival times update live
- Sat / Sun switch: stops closed that day are flagged and left off the route
- "Suggest best order" finds the order with the earliest finish that respects each stop's hours
- Apple Maps links for the full route, each leg, and each stop (Google Maps link as backup)
- Entrance pins: each site carries a `door` coordinate (OpenStreetMap entrance nodes, hand-checked for the planned stops) and an optional `enter` line like "Main entrance on Wells St." Map pins, walking routes and map-app directions all go to the door, not the postal address
- Add a break: drop lunch, coffee, or Helen's (740 N Plankinton) between stops, from a preset, a downtown place search (OpenStreetMap Nominatim), your location, or a tap on the map. Breaks have their own length and stay put when you re-optimize the order
- The Hop, live: streetcar positions from the TransLoc public map feed (`hop.js`), polled every 30 s while the page is open. Arrival times are estimated from each car's position and the scheduled run time between stops. The plan flags legs where riding beats walking, and the "up next" card says whether to hop or walk right now. If the feed is down, `hop-data.js` (a route/schedule snapshot) takes over

Hours come from the Historic Milwaukee 9/24/26 printable site list.

## Run

Open `index.html` via any static server, or enable GitHub Pages (Settings → Pages → deploy from branch, root).
