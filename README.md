# VCE Hub CAS

The source of the CAS calculator at [vcehub.com.au/cas](https://vcehub.com.au/cas): a calculator in the browser for VCE Mathematical Methods, Specialist Mathematics and General Mathematics, which works the way a handheld CAS does. The maths runs on [Giac](https://www-fourier.univ-grenoble-alpes.fr/~parisse/giac.html).

It's free software under the GNU General Public License, version 3 or later. See `LICENSE`. There is no warranty.

## What's here

- `features/cas/`: the calculator (React and TypeScript): keypad, screen, menus, the Calculator and Graphs pages, and the layer that turns Giac's answers into a handheld's forms.
- `public/cas/worker.js`: loads Giac in a web worker.
- `public/cas/giac/`: Giac's licence, and where its source is.
- `shared/`: the few VCE Hub site files the calculator imports.
- `scripts/`: the engine checks, and the script that publishes this repo.

This is a copy of the calculator's code from the VCE Hub site, updated after each change that goes live. Each sync is tagged `vcehub-<commit>`. It builds inside the site's Next.js app, not on its own.

## Giac

Giac is by Bernard Parisse and Renée De Graeve (Institut Fourier, Université Grenoble Alpes), under the GPL v3 or later. The calculator runs their WebAssembly build from giac 1.9.0-996, unmodified. Its source, which contains that exact file, is attached to the [giac-1.9.0 release](https://github.com/vcehub/cas/releases/tag/giac-1.9.0). Details in `public/cas/giac/SOURCE.md`.

## Contact

Problems with the calculator: use Feedback on the page. Anything about this code or its licence: support@vcehub.com.au.

Not affiliated with Texas Instruments.
