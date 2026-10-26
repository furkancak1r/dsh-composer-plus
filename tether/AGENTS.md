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
2. Sign the runner app with the Tether team. Set these variables in the shell that runs agent-device:
   - `AGENT_DEVICE_IOS_TEAM_ID=9LYL5R6LS4`
   - `AGENT_DEVICE_IOS_BUNDLE_ID=com.furkancakir.agentdevice.runner`

The first run builds the runner app and installs it on the iPhone. This run takes more time than the next runs.

### Use

Simulator:

1. Build: `xcodebuild -project ios/DSHMobile.xcodeproj -scheme DSHMobile -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/DerivedData build CODE_SIGNING_ALLOWED=NO`
2. Install: `agent-device install com.furkancakir.dshmobile build/DerivedData/Build/Products/Debug-iphonesimulator/DSHMobile.app --platform ios`
3. Open: `agent-device open com.furkancakir.dshmobile --platform ios --foreground`

iPhone (the device name is `iPhone`; if `open` cannot find it, run `agent-device devices --platform ios`):

1. Build: `xcodebuild -project ios/DSHMobile.xcodeproj -scheme DSHMobile -configuration Debug -destination 'platform=iOS,name=iPhone' -derivedDataPath build/DerivedData -allowProvisioningUpdates build`
2. Install: `agent-device install com.furkancakir.dshmobile build/DerivedData/Build/Products/Debug-iphoneos/DSHMobile.app --platform ios --device iPhone`
3. Open: `agent-device open com.furkancakir.dshmobile --platform ios --device iPhone --foreground`

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

## Tests

- Gateway and Mobile connect: `npm test` in the repository root (`test/tether-gateway.test.mjs`, `test/mobile-connect.test.mjs`). Real dsh: `test/browser-mobile-connect.mjs`.
- iOS unit tests: `cd ios && xcodebuild -project DSHMobile.xcodeproj -scheme DSHMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test CODE_SIGNING_ALLOWED=NO`
- After a change to `ios/project.yml`, run `cd ios && xcodegen generate`.
