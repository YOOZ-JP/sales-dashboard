/**
 * Sanity checks for the golden-template fallback lookups.
 * Run: node --import tsx scripts/test-input-v2-template-lookups.ts
 */

import assert from "node:assert/strict";

import {
  clientCodeToDisplay,
  loadInputV2TemplateLookups,
  platformCodeToChannel,
  rawChannelCodeToTemplate,
} from "../src/features/settlement/lib/export/input-v2-template-lookups";

async function main() {
  const lookups = await loadInputV2TemplateLookups();

  const clientOf = (channel: string) => lookups.channelByCode.get(channel)?.clients;
  assert.equal(clientOf("cmoa"), "NTTsolmare", "cmoa clients");
  assert.equal(clientOf("piccoma"), "Piccoma", "piccoma clients");
  assert.equal(clientOf("line_ads"), "Line Digital Frontier", "line_ads clients");
  assert.equal(clientOf("booklive"), "Booklive", "booklive clients");
  assert.equal(clientOf("renta"), "PAPYLESS", "renta clients");

  assert.equal(platformCodeToChannel("line_ad"), "line_ads", "line_ad alias");
  assert.equal(platformCodeToChannel("mediado"), "mediado_sales", "mediado alias");
  assert.equal(platformCodeToChannel("ebj_line"), "ebj", "ebj_line alias");
  assert.equal(platformCodeToChannel("u_next"), "u-next", "u_next alias");
  assert.equal(rawChannelCodeToTemplate("sb_creative"), "sb creative", "raw sb_creative alias");
  assert.equal(
    rawChannelCodeToTemplate("piccoma_gaiakuhan"),
    "piccoma_sales",
    "raw piccoma_gaiakuhan alias",
  );
  assert.equal(rawChannelCodeToTemplate("Jumptoon"), "Jumptoon", "known raw channel preserved");

  assert.equal(clientCodeToDisplay("nttsolmare"), "NTTsolmare", "nttsolmare display");
  assert.equal(
    clientCodeToDisplay("line_dl_frontier"),
    "Line Digital Frontier",
    "line_dl_frontier display",
  );
  assert.equal(clientCodeToDisplay("papyless"), "PAPYLESS", "papyless display");
  assert.equal(clientCodeToDisplay("u_next"), "U-NEXT", "u_next display");
  assert.equal(clientCodeToDisplay("sb_creative"), "sb creative", "sb_creative display");
  assert.equal(clientCodeToDisplay("comico_jp"), "comico JP", "comico_jp display");
  assert.equal(clientCodeToDisplay("comico"), "comico JP", "comico display");
  assert.equal(clientCodeToDisplay("MBJ"), "MBJ", "client code lookup is case-insensitive");
  assert.equal(clientCodeToDisplay("unknown_client"), null, "unknown client code → null");

  // Row-level raw channel codes resolve against the template, including
  // mixed-case codes like Jumptoon (matched case-insensitively by the loader).
  const channelClients = new Map(
    [...lookups.channelByCode.values()].map((info) => [
      info.channel.toLowerCase(),
      info.clients,
    ]),
  );
  assert.equal(channelClients.get("bookcomi"), "Booklive", "bookcomi clients");
  assert.equal(channelClients.get("dmm_fanza"), "DMM", "dmm_fanza clients");
  assert.equal(channelClients.get("line"), "Line Digital Frontier", "line clients");
  assert.equal(channelClients.get("ebj_webtoon"), "Line Digital Frontier", "ebj_webtoon clients");
  assert.equal(channelClients.get("jumptoon"), "shueisha", "Jumptoon clients");
  assert.equal(channelClients.get("manga mee"), "shueisha", "manga mee clients");

  assert.ok(lookups.channelByCode.size > 0, "channel lookup is non-empty");
  assert.ok(lookups.titleByChannelTitle.size > 0, "title lookup is non-empty");

  console.log(
    `OK: ${lookups.channelByCode.size} channels, ${lookups.titleByChannelTitle.size} title keys`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
