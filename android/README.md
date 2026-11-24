# Matium Mail for Android

A Trusted Web Activity (TWA): a small native shell that opens
https://webmail.matiumtech.com full-screen in Chrome. It shares Chrome's
sign-in, and every web deploy reaches the app immediately — only change and
re-release the app for a new icon, name, colours or Android settings.

Generated with Bubblewrap (`twa-manifest.json` records the settings).
Package id: `com.matiumtech.mail` (permanent once on the Play Store).

## Signing key — back it up

`~/.matium-mail/android/upload-key.jks` + `keystore.properties` (password).
Not in git. Without it you can never publish an update under the same app,
so copy both somewhere safe (password manager / encrypted drive).
Point `MATIUM_ANDROID_KEYSTORE_PROPERTIES` at the properties file to build
from elsewhere.

## Build

```sh
cd android
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties   # once
./gradlew assembleRelease bundleRelease
```

- `app/build/outputs/apk/release/app-release.apk` — install directly on a phone
- `app/build/outputs/bundle/release/app-release.aab` — upload to Google Play

Bump `versionCode` / `versionName` in `app/build.gradle` for each release.

## No address bar

Chrome hides its URL bar only when the site vouches for the app in
`public/.well-known/assetlinks.json` (served un-gated; see `src/proxy.ts`).
That file lists the signing key's SHA-256. If the app is published with
Google Play App Signing, add Play's "App signing key certificate" SHA-256
(Play Console → Setup → App integrity) to the same list and redeploy.
