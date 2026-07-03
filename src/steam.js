const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";

export function buildSteamOpenIdRedirect({ realm, returnTo }) {
  const url = new URL(STEAM_OPENID_URL);
  url.searchParams.set("openid.ns", "http://specs.openid.net/auth/2.0");
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", realm);
  url.searchParams.set("openid.identity", "http://specs.openid.net/auth/2.0/identifier_select");
  url.searchParams.set("openid.claimed_id", "http://specs.openid.net/auth/2.0/identifier_select");
  return url.toString();
}

export async function verifySteamOpenIdResponse(queryParams) {
  const body = new URLSearchParams();
  for (const [key, value] of queryParams.entries()) {
    body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await response.text();
  return text.includes("is_valid:true");
}

export function extractSteamIdFromClaimedId(claimedId) {
  if (!claimedId) {
    return null;
  }

  const match = claimedId.match(/https:\/\/steamcommunity\.com\/openid\/id\/(\d+)/i);
  return match ? match[1] : null;
}

export async function fetchSteamProfileAndBans(steamApiKey, steamId) {
  const profileUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(
    steamApiKey
  )}&steamids=${encodeURIComponent(steamId)}`;

  const bansUrl = `https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${encodeURIComponent(
    steamApiKey
  )}&steamids=${encodeURIComponent(steamId)}`;

  const [profileRes, bansRes] = await Promise.all([fetch(profileUrl), fetch(bansUrl)]);

  if (!profileRes.ok) {
    throw new Error(`Steam profile API failed with status ${profileRes.status}`);
  }

  if (!bansRes.ok) {
    throw new Error(`Steam bans API failed with status ${bansRes.status}`);
  }

  const profileJson = await profileRes.json();
  const bansJson = await bansRes.json();

  const player = profileJson?.response?.players?.[0] || null;
  const bans = bansJson?.players?.[0] || null;

  if (!player) {
    throw new Error("No Steam player profile found for this account.");
  }

  return {
    steamId,
    personaName: player.personaname || "Unknown",
    profileUrl: player.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
    avatar: player.avatarfull || player.avatarmedium || player.avatar || null,
    bans: {
      communityBanned: Boolean(bans?.CommunityBanned),
      vacBanned: Boolean(bans?.VACBanned),
      numberOfVacBans: Number(bans?.NumberOfVACBans || 0),
      daysSinceLastBan: Number(bans?.DaysSinceLastBan || 0),
      numberOfGameBans: Number(bans?.NumberOfGameBans || 0),
      economyBan: bans?.EconomyBan || "none"
    }
  };
}
