<div align="center">

<br>

[![SikuliX](https://raw.githubusercontent.com/oculix-org/SikuliX1/master/Support/sikulix-red.png)](https://github.com/oculix-org/Oculix)

<br>

# SikuliX1

### Historical SikuliX1 codebase, preserved here with fork-specific experiments

<br>

![Status](https://img.shields.io/badge/status-active%20fork-1f883d?style=for-the-badge)
![Core](https://img.shields.io/badge/core-Java%2011%20%7C%202.1.0--SNAPSHOT-1f6feb?style=for-the-badge)
![Extension](https://img.shields.io/badge/extension-Chrome%20MV3%20%7C%20v2.0.0-f59e0b?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-lightgrey?style=for-the-badge)

</div>

---

## Where to go

| If you want to... | Start here |
|---|---|
| Use the actively maintained SikuliX successor | [oculix-org/Oculix](https://github.com/oculix-org/Oculix) |
| Work on the legacy Java API or IDE | [`API/`](API) and [`IDE/`](IDE) |
| Explore the browser automation prototype | [`chrome-extension/`](chrome-extension) |
| See the preserved mirror this fork tracks | [oculix-org/SikuliX1](https://github.com/oculix-org/SikuliX1) |
| See the original archived upstream | [RaiMan/SikuliX1](https://github.com/RaiMan/SikuliX1) |

---

## What this repository is now

This repository is no longer just a passive mirror. In its current state, it combines:

- the historical SikuliX1 Maven multi-module Java codebase
- the legacy `API` and `IDE` sources for the 2.x line
- GitHub Actions workflows for compiling and packaging historical builds
- an experimental `chrome-extension/` project for SikuliX-style browser automation inside Chrome
- support assets and static pages preserved from the original project layout

If you are looking for the mainline future of SikuliX, use **OculiX**. If you are working on preservation, compatibility, research, or fork-specific experiments, this repo is the right place.

---

## Repo layout

- [`API/`](API): Java API for screen capture, image matching, OCR, and native input automation.
- [`IDE/`](IDE): Swing-based scripting IDE and runner built on top of the API.
- [`chrome-extension/`](chrome-extension): Manifest V3 Chrome extension with template capture, a workflow editor, a code editor, recording support, and side-panel execution tools.
- [`pages/`](pages): legacy static site content for downloads and project pages.
- [`Support/`](Support): packaging assets, templates, and archived helper material.

---

## Legacy Java build notes

Root `pom.xml` is an aggregator for:

- `com.sikulix:sikulixapi`
- `com.sikulix:sikulixide`

Common commands:

```bash
mvn -pl API compile
mvn -pl API package
mvn -pl IDE -P complete-win-jar package -DskipTests
mvn -pl IDE -P complete-mac-jar package -DskipTests
mvn -pl IDE -P complete-lux-jar package -DskipTests
```

Notes:

- The legacy Java build is still centered on Java 11 in the Maven configuration and CI workflows.
- There is no automated test suite in this repository today, so validation is mostly by compile/build and manual runtime checks.

---

## Chrome extension prototype

The `chrome-extension/` folder is a fork-specific experiment that brings SikuliX-style visual automation into Chrome.

Current capabilities in this repo include:

- capturing image templates from the current tab
- storing templates in extension storage
- building and reordering visual workflow steps
- exporting workflow steps into executable code
- running actions such as click, right-click, double-click, wait, type, key, scroll, and pause
- recording user interactions into workflow steps
- previewing captured images and executing through a Chrome side panel

To load it locally:

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Choose **Load unpacked**
4. Select the [`chrome-extension/`](chrome-extension) folder

This prototype uses elevated browser permissions such as `tabs`, `scripting`, `storage`, `sidePanel`, `debugger`, and host access to automate the active tab.

---

## What SikuliX is

SikuliX is a visual automation tool built around computer vision. It finds GUI elements by image matching and then interacts with them using simulated mouse and keyboard input. The original idea still fits:

> If you can see it, you can automate it.

---

## Heritage

This code sits in a long MIT-licensed lineage:

- MIT CSAIL research that introduced the original Sikuli concept
- the Sikuli open source project and its academic publication era
- Raimund Hocke's long stewardship of SikuliX1
- continued preservation and forward development in newer forks such as OculiX

Many people carried this project across multiple generations. This fork keeps that history accessible while making room for new experiments.

---

<div align="center">
<sub>MIT-licensed. For active core development, see <a href="https://github.com/oculix-org/Oculix">oculix-org/Oculix</a>.</sub>
</div>
