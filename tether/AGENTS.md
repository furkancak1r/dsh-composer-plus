# Tether: rules for agents

Tether is part of dsh-composer-plus. The rules in `../AGENTS.md` also apply. Paths below are relative to this `tether/` folder.

Tether has two parts:

- `ios/`: the native SwiftUI iPhone app (iOS 17+). The bundle ID is `com.furkancakir.dshmobile`. XcodeGen makes the project file from `ios/project.yml`. The app is not in the npm package.
- `gateway/`: the Mac gateway. It uses only the Node standard library. dsh-composer-plus runs it in the dsh Host process while the user switches on Settings → Composer Plus → Mobile connect (iPhone) (`../index.js`).

## iPhone and simulator work: use agent-device

Use [agent-device](https://github.com/callstack/agent-device) for each task that opens, controls or examines the app on an iPhone or an iOS simulator.

### Install

When `command -v agent-device` shows no path, do these steps:

1. Make sure that Node.js is 22.12 or newer: `node --version`.
2. Install the CLI: `npm install -g agent-device@latest`.
3. Make sure that Xcode has the iOS platform. If it does not, tell the user to install it in Xcode > Settings > Components.
4. Run `agent-device doctor` and correct the problems that it shows.

Do not use `npx -y agent-device@latest` in place of the installed CLI.

For a physical iPhone, also do these steps:

1. Make sure that the iPhone is paired, trusted and unlocked, and that Developer Mode is on. Read `agent-device help physical-device`.
2. On this Mac, `DevToolsSecurity -status` must say "enabled". When it says "disabled", the runner cannot start (`devtools_security_developer_mode_disabled`) and `snapshot` fails. Only the owner can switch it on with `sudo DevToolsSecurity -enable` (it asks for the Mac password). The owner enabled it on 2026-10-27. This is the Mac setting, not the iPhone's Developer Mode.
3. Set these variables in the shell that runs agent-device:
   - `AGENT_DEVICE_IOS_TEAM_ID=9LYL5R6LS4`
   - `AGENT_DEVICE_IOS_BUNDLE_ID=com.furkancakir.agentdevice.runner`
4. agent-device builds its runner with Automatic Signing, and that fails here ("No Accounts", `signing_provisioning_profile_missing`). Build the runner without signing, sign it with the TetherSigning files (see "Signing for the iPhone"), and give agent-device the result. Do this again after an agent-device update (the runner must come from the same version):

```sh
D="$PWD/build/adrunner"; R=/opt/homebrew/lib/node_modules/agent-device/dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj
xcodebuild build-for-testing -project "$R" -scheme AgentDeviceRunner -parallel-testing-enabled NO -maximum-concurrent-test-device-destinations 1 \
  -destination generic/platform=iOS -derivedDataPath "$D" COMPILER_INDEX_STORE_ENABLE=NO ENABLE_CODE_COVERAGE=NO ONLY_ACTIVE_ARCH=YES ENABLE_PREVIEWS=NO \
  ENABLE_DEBUG_DYLIB=NO -IDEPackageSupportDisableManifestSandbox=1 -IDEPackageSupportDisablePluginExecutionSandbox=1 ENABLE_USER_SCRIPT_SANDBOXING=NO \
  'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY' \
  AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.furkancakir.agentdevice.runner AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.furkancakir.agentdevice.runner.uitests \
  CODE_SIGNING_ALLOWED=NO DEVELOPMENT_TEAM=9LYL5R6LS4
```

Then make the temporary keychain of "Signing for the iPhone" (its lines from `S=` to `ID=`; the app path `A` is not used here) and sign the three bundles from the inside out:

```sh
P="$D/Build/Products/Debug-iphoneos"; RA=$P/AgentDeviceRunnerUITests-Runner.app; T=$RA/PlugIns/AgentDeviceRunnerUITests.xctest; AA=$P/AgentDeviceRunner.app
ent() { printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>application-identifier</key><string>9LYL5R6LS4.%s</string><key>com.apple.developer.team-identifier</key><string>9LYL5R6LS4</string><key>get-task-allow</key><true/><key>keychain-access-groups</key><array><string>9LYL5R6LS4.%s</string></array></dict></plist>\n' "$1" "$1" > "$W/$1.plist"; }
ent com.furkancakir.agentdevice.runner.uitests.xctrunner; ent com.furkancakir.agentdevice.runner
codesign -f -s "$ID" --keychain "$KC" --timestamp=none "$T"
cp "$S/dev.mobileprovision" "$RA/embedded.mobileprovision"; cp "$S/dev.mobileprovision" "$AA/embedded.mobileprovision"
codesign -f -s "$ID" --keychain "$KC" --entitlements "$W/com.furkancakir.agentdevice.runner.uitests.xctrunner.plist" --timestamp=none "$RA"
codesign -f -s "$ID" --keychain "$KC" --entitlements "$W/com.furkancakir.agentdevice.runner.plist" --timestamp=none "$AA"
codesign --verify --deep --strict "$RA" && codesign --verify --deep --strict "$AA" && echo signed
security delete-keychain "$KC"; rm -f "$W"/com.furkancakir.agentdevice.*.plist; unset PW
```

Open with the signed runner: `agent-device open com.furkancakir.dshmobile --platform ios --device iPhone --foreground --ios-xctestrun-file "$(ls $D/Build/Products/*.xctestrun)" --ios-xctest-derived-data-path "$D"`. Give the same two flags to each `open`. The runner stays signed until the profile ends (2027-10-20).

On a physical iPhone, `agent-device clipboard read` does not work. To check a copy, paste into a text field of the app (touch and hold, then Paste) and read the field.

### Signing for the iPhone

Xcode on this Mac has no Apple account, so `-allowProvisioningUpdates` fails ("No Accounts", "No profiles for 'com.furkancakir.dshmobile'"). The owner does not want to sign in to Xcode. Sign with the files in `~/Library/Application Support/TetherSigning/` instead:

- `dev.key` + `dev.pem` (= `dev.cer`): the Apple Development certificate of team 9LYL5R6LS4. It ends on 2027-10-20.
- `dev.mobileprovision`: "Tether Device Build 2026-10-20", App ID `9LYL5R6LS4.*`, includes the owner's iPhone 13 (device name `iPhone`). It ends on 2027-10-20. A new iPhone is not in it: then the owner must make a new profile.
- `ent.plist`: the app's entitlements.
- `tether-sign.keychain-db`, `kc.pw` and `dev.p12`: do not use them. `kc.pw` does not open the keychain or `dev.p12`.

Use these files only when the owner asks for an iPhone build. Never print, copy or commit the key. Build without signing, then sign with a temporary keychain under `build/signing/` (git ignores `build/`) and delete it at once:

```sh
xcodebuild -project ios/DSHMobile.xcodeproj -scheme DSHMobile -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData build CODE_SIGNING_ALLOWED=NO
S="$HOME/Library/Application Support/TetherSigning"; W="$PWD/build/signing"; A=build/DerivedData/Build/Products/Debug-iphoneos/DSHMobile.app
mkdir -p "$W" && chmod 700 "$W"; KC="$W/tmp.keychain-db"; export PW=$(openssl rand -hex 24)
security create-keychain -p "$PW" "$KC" && security set-keychain-settings "$KC" && security unlock-keychain -p "$PW" "$KC"
openssl pkcs12 -export -legacy -inkey "$S/dev.key" -in "$S/dev.pem" -name "Tether Dev" -passout env:PW -out "$W/tmp.p12"
security import "$W/tmp.p12" -k "$KC" -f pkcs12 -P "$PW" -T /usr/bin/codesign >/dev/null && rm "$W/tmp.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
ID=$(security find-identity -v -p codesigning "$KC" | awk '/Apple Development/ {print $2; exit}')
cp "$S/dev.mobileprovision" "$A/embedded.mobileprovision"
for x in "$A"/*.dylib; do codesign -f -s "$ID" --keychain "$KC" --timestamp=none "$x"; done
codesign -f -s "$ID" --keychain "$KC" --entitlements "$S/ent.plist" --timestamp=none "$A" && codesign --verify --deep --strict "$A" && echo signed
security delete-keychain "$KC"; unset PW
```

Then install with `xcrun devicectl device install app --device iPhone build/DerivedData/Build/Products/Debug-iphoneos/DSHMobile.app`. This keeps the app's data (pairings, settings). `agent-device install` and `reinstall` remove it, so after them the phone must pair again.

### Use

Simulator:

1. Build: `xcodebuild -project ios/DSHMobile.xcodeproj -scheme DSHMobile -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData build CODE_SIGNING_ALLOWED=NO`
2. Install: `agent-device install com.furkancakir.dshmobile build/DerivedData/Build/Products/Debug-iphonesimulator/DSHMobile.app --platform ios`
3. Open: `agent-device open com.furkancakir.dshmobile --platform ios --foreground`

iPhone (the device name is `iPhone`; if `open` cannot find it, run `agent-device devices --platform ios`):

1. Build and sign: see "Signing for the iPhone" above. (`-allowProvisioningUpdates` works only when Xcode has an Apple account.)
2. Install: `xcrun devicectl device install app --device iPhone build/DerivedData/Build/Products/Debug-iphoneos/DSHMobile.app` (keeps the app's data).
3. Open: `agent-device open com.furkancakir.dshmobile --platform ios --device iPhone --foreground` with the two runner flags of physical iPhone step 4. If the first snapshot fails with "Developer mode is disabled for Apple development tools", see step 2. If it fails with `signing_provisioning_profile_missing`, see step 4.

Then, on the two targets:

1. The `open` command shows the first interactive snapshot. Do each action with a current ref and `--settle`, for example `agent-device press @e3 --settle`. Continue from the diff that the command shows.
2. Verify the expected result with `wait text "..."`, `is`, `get` or `find`. A screenshot alone is not a verification.
3. Close the session: `agent-device close`.

### Rules

- Start with `open`. Do not probe first with `--help`, `--version`, `devices`, `appstate`, `snapshot` or `screenshot`.
- A ref such as `@e3` is valid only in the latest output. Use selectors in scripts that you keep.
- Send the commands for one session one at a time.
- For logs, network data or crashes, read `agent-device help debugging`.
- Ask the user before you approve a pairing request on the admin page (`http://127.0.0.1:19391/`) of the live DSH.
- When you change a tap, a press and hold or another gesture, check each gesture and then the next tap. Do not keep a flag that waits for an event that iOS can skip (for example a tap after a press and hold). Read a state that every path resets.
- Screenshots, recordings and logs can show pairing data and chat text. Keep them in `build/agent-device/` in this folder. Git ignores `build/`. Do not commit them.

## Gateway

- When the phone closes a request, the gateway may stop dsh's request only for a route that changes nothing (for example a model call such as Improve prompt). A route that changes a chat or the project (rollback, delete-chat, continue, ideas, queue-move, grants) must run to its end on the Mac: the phone's first address times out after 5 s, and a stopped write can leave half a change.
- A setting that limits who can reach the gateway (for example "Tailscale only") also limits what the gateway announces to that network. The TCP filter is not sufficient: the Bonjour advertisement (`dns-sd`) sends the Mac name, the port and the certificate fingerprint without a connection. Apply the setting at start and when it changes at run time, and test both paths (gateway tests pass `bonjour: false`, so give the test its own `spawn`).

## Tests

- Gateway and Mobile connect: `npm test` in the repository root (`test/tether-gateway.test.mjs`, `test/mobile-connect.test.mjs`). Real dsh: `test/browser-mobile-connect.mjs`.
- iOS unit tests: `cd ios && xcodebuild -project DSHMobile.xcodeproj -scheme DSHMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test CODE_SIGNING_ALLOWED=NO`
- After a change to `ios/project.yml`, run `cd ios && xcodegen generate`.
