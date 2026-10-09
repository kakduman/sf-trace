# SF-TRACE

SF-TRACE (San Francisco Transit Ridership And Choice Estimator) is an open model of transit ridership and travel choices in San Francisco. It runs in the browser: it estimates ridership on every route, compares it with passenger counts, and runs scenarios you build.

- App: https://kakduman.github.io/sf-trace/
- Methodology: https://kakduman.github.io/sf-trace/method/

## Run locally

Needs Node 22 or later.

```sh
npm ci
npm run dev        # http://localhost:5180/ (the methodology is at /method/)
```

Other scripts:

- `npm run build` builds the static site into `dist/`. Set `BASE_PATH` to build for a fixed path, e.g. `BASE_PATH=/sf-trace/ npm run build`; the default is relative paths, which work under any path.
- `npm run preview` serves `dist/`.
- `npm test` and `npm run typecheck`.
- `npm run build:wasm` rebuilds the WebAssembly kernels in `wasm/` (AssemblyScript).

The dev server sends cross-origin isolation headers, so the workers share memory. Static hosts such as GitHub Pages don't send them; the app then copies its arrays between workers instead, with the same results.

## Layout

- `client/`: the app (`index.html`, `client/beta3/`) and the methodology article (`method/index.html`, `client/beta3/paper/`).
- `shared/beta3/`: the model, used by the browser and by the pipeline.
- `server/beta3/pipeline/`: the data pipeline; `server/beta3/reference/`: observed data and published parameters, with sources.
- `client/beta3/model/`: the model files the app loads, built by the pipeline.
- `test/`: tests.

## Rebuilding the model data

The raw downloads are not in the repository; `npm run model:fetch` fetches them into `data/`. Then `npm run model:build` and `npm run model:calibrate` rebuild the model files. A few inputs have to be downloaded by hand. The methodology's section "Data, code, and reproducibility" lists every step and its outputs. The scripts need about 3 GB of memory.

## Deploying

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on each push to `main`.

## Author

[Koray Akduman](https://korayakduman.com)\*

\* With substantial help from AI systems. Not peer reviewed.

## Citing

The methodology page has a "How to cite" section with the current version, and a BibTeX entry:

> Koray Akduman. SF-TRACE 1.0: San Francisco Transit Ridership And Choice Estimator. An open model of transit ridership and travel choices in San Francisco. Version 1.0, 2026. [URL to be added]

## License

MIT. See [LICENSE](LICENSE).
