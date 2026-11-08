# SB3C Packager

An independent modified version of [TurboWarp Packager](https://github.com/TurboWarp/packager), focused on offline, program-specific players that jointly compile Scratch scripts and the runtime. See [the build architecture](docs/specialized-builds.md).

Source: https://github.com/ScCNv5/packager

Website: https://sccnv5.github.io/packager/

Converts Scratch projects into HTML files, zip archives, or executable programs for Windows, macOS, and Linux.

Compilation and obfuscation are not encryption or DRM. They can make casual inspection, copying, and automated analysis more expensive, but the player must still receive executable JavaScript. A determined user can inspect, instrument, or modify it, so projects must never contain private keys, long-term secrets, or client-side security decisions.

## Development

Keep the matching modified [`ScCNv5/scratch-vm`](https://github.com/ScCNv5/scratch-vm) checkout beside this repository. Install dependencies in both checkouts (Node 22.15 or newer):

```
npm ci --prefix ../scratch-vm
npm ci
```

Start in development mode:

```
npm start
```

Then visit http://localhost:8947. Manually refresh to see changes.

Packaged projects generated while in development mode should not be distributed. Instead, you should run a production build to significantly reduce file size of both the website and the packager.

```
npm run build-prod
```

Output will be located in the `dist` folder.

The general layout of `src` is:

 - packager: The code that downloads and packages projects.
 - p4: The Svelte website for the packager. "p4" is the name that the packager uses internally to refer to itself.
 - scaffolding: A minimal Scratch project player. Handles most of the boring details of running Scratch projects like handling mouse inputs.
 - common: Some files used by both scaffolding and the packager.
 - addons: Optional addons such as gamepad support or pointerlock.
 - locales: Translations. en.json contains the original English messages. The other languages are translated by volunteers and imported by an automated script. ([you can help](https://docs.turbowarp.org/translate))
 - build: Various build-time scripts such as webpack plugins and loaders.

## Tips for forks

We strive to make the packager easy to fork, even for mods that aren't based on TurboWarp. Reading this section, at least the first half, should make it much easier to do so.

### Packages

The compiler frontend, source preparation and player must use the same sibling `scratch-vm` checkout. A generic upstream VM does not provide the specialized IR API. Dependency changes require regenerating the source pack, reviewing initialization/property boundaries and running the differential, artifact and browser checks described in [the build documentation](docs/specialized-builds.md). The lockfile and audited dependency source hashes form part of the build baseline.

Note that npm is a very buggy piece of software and our dependency tree is very large. Occasionally you might get errors about missing dependencies, which should go away if you run `npm install`.

### Deployment

The packager is deployed as a simple static website. You can host it anywhere by just copying the `dist` folder after a build.

This fork includes `.github/workflows/deploy.yml` for GitHub Pages. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. A push to `main`, or a manual run of “Deploy to GitHub Pages”, will test the project, build the production website and standalone version, upload the Pages artifact, and deploy it to `https://sccnv5.github.io/packager/`.

We use GitHub Actions and GitHub Pages to manage our deployment. If you want to do this too:

 - Fork the repository on GitHub and push your changes.
 - Go to your fork's settings on GitHub and enable GitHub Pages with the source set to GitHub Actions.
 - Go to the "Actions" tab and enable GitHub Actions if it isn't already enabled.
 - Push commits to the "main" branch.
 - In a few minutes, your site will automatically be built and deployed to GitHub Pages.

### Branding

We ask that you at least take a moment to rename the website by editting `src/packager/brand.js` with your own app name, links, etc.

### Large files

Large files such as NW.js, Electron, and WKWebView executables are stored on an external server outside of this repository. While we aren't actively removing old files (the server still serves files unused since November 2020), we can't promise they will exist forever. The packager uses a secure checksum to validate these downloads. Forks are free to use our servers, but it's easy to setup your own if you'd prefer (it's just a static file server; see `src/packager/large-assets.js` for more information).

### Service worker

Set the environment variable `ENABLE_SERVICE_WORKER` to `1` to enable service worker for offline support (experimental, not 100% reliable). This is not recommended in development. Our GitHub Actions deploy script uses this by default.

## Standalone builds

The packager supports generating "standalone builds" that are single HTML files containing the entire packager, including its compiler, resolved runtime sources and linker. HTML builds work offline; desktop wrapper binaries and extensions not supplied locally are fetched during construction. Standalone builds do not contain an update checker.

To make a production standalone build locally:

```
npm run build-standalone-prod
```

The build outputs to `dist/standalone.html`.

## Node.js module and API

See [node-api-docs/README.md](node-api-docs/README.md) for Node.js API documentation.

To build the Node.js module locally:

```
npm run build-node-prod
```

## License

<!-- Make sure to also update COPYRIGHT_NOTICE in src/packager/brand.js -->

SB3C Packager modifications Copyright (C) 2026 SB3C Packager contributors

Based on TurboWarp Packager, Copyright (C) 2021-2024 Thomas Weber

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
