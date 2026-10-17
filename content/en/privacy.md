---
title: Privacy notice
description: What this Nafyn instance stores about you, why, and for how long.
updated: 2026-10-12
---

Nafyn is self-hosted software: this notice describes what the software stores and why. The person or
organisation running this particular instance decides everything else, and is who you contact about your
data.

<!--
  Operator notes (not rendered - HTML comments are stripped from the output):

  * You are the data controller. You may amend this notice, and you should if your deployment does anything
    Nafyn itself does not - extra analytics, a reverse proxy that logs requests, off-site backups, an
    account-provisioning process that collects an email address, and so on.
  * Do NOT add your name or contact details here. The page renders those above this document from
    NAFYN_PRIVACY_CONTROLLER / NAFYN_PRIVACY_CONTACT, so they stay correct without a rebuild.
  * This file is parsed at build time. Edits need a rebuild (bun run build) to appear in production.
  * Retention periods below must match the code: raw play events use insights.rawEventRetentionDays
    (default 1095 days), the recently-played shelf uses retention.recentlyPlayedDays (default 180 days),
    sessions expire after 7 days. If you retune those app_settings, retune this too.
-->

## What is stored

All of it stays on this instance's own server and database. Nothing below is sold, shared with advertisers,
or used to profile you across other services.

### Your account

Username, optional display name, optional avatar image, your permissions, and the Last.fm / Discogs
usernames you choose to link. Needed to have an account at all.

*Kept until you delete your account.*

### Your credentials

Your password as a bcrypt hash (never the password itself), any passkeys you register, and any API tokens
you generate for Subsonic apps.

*Kept until you remove them, or until you delete your account.*

### Logins

One record per login, holding the IP address and browser user agent it came from, so you can see your
active sessions and sign a lost device out.

*Deleted when the session expires (7 days) or shortly after you revoke it.*

### Your library

Which tracks you have access to, and when they were added. Audio files themselves are shared between users
of this instance, not duplicated per person.

*Kept until you remove the track, or delete your account.*

### Playlists

Playlists you create, who is a member of them, and who added each track.

*Your own playlists are deleted with your account; tracks you added to someone else's playlist stay, with
your name removed.*

### Download requests

What was requested, when, and its outcome - the instance's record of what it downloaded.

*Kept as an operational record, with your account removed from it when you delete your account.*

### Recently played

The last few tracks, albums and playlists you started playback from, to fill the "recently played" shelf.

*Automatically deleted after 6 months.*

### Listening history

Off unless you turn it on. When on: what you played, when, and for how long - this is what powers your
insights, Replay Mixes and year-end summary.

*Individual plays are deleted after 3 years; the statistics built from them are kept until you delete your
history or your account. Turning the setting off stops new recording immediately.*

### Preferences

Display, playback and Nafyn Unity settings, plus your listening-history choice.

*Kept until you delete your account.*

### Notifications

Only what you set up yourself:

- **Webhooks** you add: their name, address and which events they receive. A webhook address works like a
  password for the channel it posts to, so it is never shown back to you in full or included in your export.
- **Apple device tokens**, registered by the Nafyn app on iPhone or iPad so it can show notifications, Live
  Activities and Now Playing controls. Each token is tied to the login that registered it.
- **Followed releases**: which upcoming albums and tracks you asked to be notified about, and your timezone,
  so the notification arrives at midnight your time.

*Device tokens are deleted when you sign out of that device or revoke its session, and after 6 months
without use. Followed releases are deleted 30 days after they come out. Webhooks are kept until you remove
them or delete your account.*

## What leaves the server

Nafyn queries outside services to find and identify music. These calls carry what is being searched for or
downloaded - never your username, your account id, or your listening history.

- The instance's own slskd / Soulseek instance, to search for and download files. Your Nafyn account is not
  disclosed to it; the slskd credentials belong to the operator.
- **MusicBrainz**, to resolve recordings, releases and artists.
- **AcoustID**, which receives an audio fingerprint of a downloaded file to confirm it is the right
  recording.
- **Metadata providers**, when a search needs them: Deezer, iTunes and ReccoBeats always, plus TheAudioDB,
  Discogs, Genius and Last.fm if the operator configured keys for them.
- **Cover Art Archive** and the artwork hosts of the providers above, to fetch artwork.

A text search you type is sent to those providers as the search term. If that matters to you, note that
search terms are the one thing here you control directly.

**Notifications are the exception** to "never your username", because telling someone about a request is
their whole point:

- **Webhooks** (Discord, Slack, ntfy, Gotify or another service of the webhook owner's choosing) receive the
  title, artist and cover of the media concerned, and the display name of whoever requested it. Your own
  webhooks only receive notifications meant for you. Webhooks set up by the operator for the whole instance
  receive every download request - including your name when you make one.
- **Apple Push Notification service** relays push notifications to Apple devices you registered through the
  Nafyn app; Apple acts as a processor for that delivery. If you manage requests, your devices are told about
  other people's requests, including their display names.

## Your rights

Under the GDPR you can, at any time and without giving a reason:

- **See everything held about you** (art. 15).
- **Get it as a machine-readable file** you can take elsewhere (art. 20).
- **Correct anything inaccurate** (art. 16).
- **Have your account and its data permanently deleted** (art. 17).
- **Withdraw consent for listening history**, which stops recording immediately (art. 7(3)).
- **Object to or restrict processing** (art. 18, 21).

Access, portability, listening-history consent and account deletion are all self-service, under
**Settings → Privacy & Security**.

If the operator of this instance will not act on a request, you can complain to your national data
protection authority.

## Security

Passwords are stored as bcrypt hashes. Sessions are signed tokens that can be revoked individually. Whether
this instance is reachable over HTTPS, who can see its database, and how it is backed up are all down to
its operator - ask them if you need to know.

One exception worth knowing: API tokens for Subsonic apps are stored in readable form, because the Subsonic
protocol's authentication requires it. Treat one like a password and revoke it if a device is lost.
