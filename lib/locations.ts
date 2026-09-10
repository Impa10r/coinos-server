import { db, g, s } from "$lib/db";
import { err, l } from "$lib/logging";
import { fields, getUser } from "$lib/utils";
import got from "got";

const dedup = (array) =>
  Object.values(
    array.reduce((acc, obj) => {
      if (!acc[obj.id] || new Date(obj.updated_at) > new Date(acc[obj.id].updated_at)) {
        acc[obj.id] = obj;
      }
      return acc;
    }, {}),
  );

// btcmap goes down from time to time (a 502 from their gateway, a timeout).
// This loop retries every 60s, keeps the previously cached locations on
// failure, and only advances `locations:since` on success — so a blip costs
// one skipped refresh and loses no window. Escalate on sustained failure
// instead of on every tick: a single miss isn't worth an error-level line,
// but an hour of them means btcmap is properly down or we've been blocked.
let locationFailures = 0;
const LOCATION_FAILURES_BEFORE_ERR = 60;

export const getLocations = async () => {
  try {
    const previous = (await g("locations")) || [];
    let since = await g("locations:since");
    if (!since) since = "2022-09-19T00:00:00Z";
    if (Date.now() - new Date(since).getTime() < 60000) return;

    let locations: Array<any> = await got(
      `https://api.btcmap.org/v2/elements?updated_since=${since}`,
    ).json();

    locations = locations.filter(
      (l) =>
        l.osm_json.tags &&
        l.osm_json.tags["payment:coinos"] === "yes" &&
        l.osm_json.tags.name &&
        !l.deleted_at,
    );

    locations.map((l) => {
      const { bounds, lat, lon } = l.osm_json;

      l.osm_json.lat = lat || (bounds.minlat + bounds.maxlat) / 2;
      l.osm_json.lon = lon || (bounds.minlon + bounds.maxlon) / 2;
    });

    for await (const l of locations) {
      const username = l.tags["payment:coinos"];
      if (username) {
        const user = await getUser(username, fields);
        if (user) l.osm_json.tags.user = user;
      }
    }

    locations.push(...previous);

    const dedupedLocations = dedup(locations);
    await s("locations", dedupedLocations);
    await s("locations:since", `${new Date().toISOString().split(".")[0]}Z`);

    for (const loc of dedupedLocations as any) {
      if (loc.deleted_at) continue;
      const { lat, lon } = loc.osm_json;
      if (!(lat && lon)) continue;
      await db.geoAdd("locations:geo", { longitude: lon, latitude: lat, member: String(loc.id) });
      await s(`location:${loc.id}`, loc);
    }
    locationFailures = 0;
  } catch (e) {
    locationFailures++;
    if (locationFailures >= LOCATION_FAILURES_BEFORE_ERR)
      err("problem fetching locations", `${locationFailures} consecutive`, e.message);
    else l("problem fetching locations (transient)", e.message);
  }

  setTimeout(getLocations, 60000);
};
