# Nimbus

Nimbus is a desktop-ready Pomodoro timer built from the existing single-page HTML app in `pomodoro-cloud-v2.html`.

## Run Locally

```sh
npm install
npm start
```

## Build Desktop Clients

macOS:

```sh
npm run dist:mac
```

Windows:

```sh
npm run dist:win
```

The packaged clients are written to `dist/`.

## Automated Builds

The GitHub Actions workflow in `.github/workflows/desktop-builds.yml` builds real macOS and Windows artifacts on the correct operating systems. It runs on pushes to `main` and can also be started manually from the Actions tab.

The generated apps are unsigned. macOS Gatekeeper and Windows SmartScreen may warn until the app is signed with Apple Developer ID and Windows code-signing certificates.
