# Adaptive Exam Mission

Static iPad-first prototype for turning a teacher-provided Algebra 1 final review
packet into an adaptive study mission.

## What It Does

- Starts with a diagnostic sample instead of marching through the whole packet.
- Lets the student work with an Apple Pencil-style scratch canvas.
- Shows worked solutions after the attempt.
- Uses honest self-grades to infer weak skill clusters.
- Routes into a teach/rebuild/retest path for weak spots.
- Stores progress locally in the browser.

## Deploy On GitHub Pages

1. Create a new GitHub repo.
2. Upload `index.html` from this folder.
3. In GitHub, go to `Settings` → `Pages`.
4. Set source to `Deploy from a branch`.
5. Choose the `main` branch and `/root`.
6. Open the generated GitHub Pages URL on the iPad.

No backend is required for this prototype.

## Notes

The prototype uses MathJax from a CDN for math rendering. If the iPad is offline,
the page still loads, but math notation will render as plain text in some places.
