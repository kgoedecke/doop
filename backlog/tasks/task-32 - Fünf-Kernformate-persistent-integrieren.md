---
id: TASK-32
title: Fünf Kernformate persistent integrieren
status: Done
assignee: []
created_date: '2026-10-23T09:51:00Z'
updated_date: '2026-11-03T20:32:00Z'
labels:
  - prowin
  - implementation
milestone: m-4
dependencies:
  - TASK-14
documentation:
  - docs/prowin/doop-fork-umsetzung.md
  - docs/prowin/bezugsdokumente-referenz.md
priority: medium
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Social- und Druckausgaben benötigen feste, reproduzierbare Maße. Bestehende Frames ohne Preset müssen weiterhin funktionieren.

Quellen: Umsetzung §§ 10.1–10.2; Referenz R1.6
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 IG Post 1080×1080, IG Story/WA Status 1080×1920, FB Post 1200×630 und A4 794×1123 CSS-px sind auswählbar.
- [x] #2 Frame.preset, Datenbankschema, Migration und Serialisierung erhalten die Auswahl über Speichern und Neuladen; alte Frames ohne preset bleiben kompatibel.
- [x] #3 Preset-Maße sind für Nicht-Creator auch serverseitig gegen Resize geschützt; Creator-Ausnahmen sind geprüft.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Gemeinsamen Formatkatalog, Frame.preset und Datenbankmigration samt Persistenz ergänzen.
2. REST-, MCP-, Resident-, Restore- und Live-Resize-Pfade über bestehende Canvas-Creator-Rechte schützen.
3. Separaten Preset-Dialog integrieren, Kopien/Undo erhalten und Resize-UI absichern.
4. Pro Schritt Spec-/Qualitätsreview, abschließend Gesamttests und Branch-Review; manuelle Abnahme bleibt offen.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
02.11.2026: Nutzer wählt separaten Preset-Dialog und gibt Entwurf sowie isolierten Worktree frei. Implementierungsplan: docs/superpowers/plans/2026-11-02-format-presets.md. Keine Änderungen an Safe-Zone-Overlay oder Exportauflösung.

02.11.2026: Implementierung auf feat/task-32-format-presets mit Subagent-Driven Development. Fünf Formate im separaten Dialog; optionale Frame.preset-Persistenz samt Migration 0041; zentrale REST/MCP/Resident/Restore/Live-Drag-Rechteprüfung. Reale HTTP-/Runtime-/PGlite-/Chromium-Tests sowie unabhängige Reviews belegen die Kriterien.
Typecheck, vollständiges Lint und Build grün; finale fokussierte Regression 208/208. Vollsuite vor letzter Fix-Welle 1855/1855; abschließender Vollsuite-Lauf noch ausstehend. Bericht: docs/superpowers/reports/2026-11-02-format-presets.md.
CodeRabbit: ursprüngliche Major-/Minor-Findings behoben; erneuter Vollreview ohne Major/Critical. Follow-up TASK-80: Preset-Maße in der automatischen Resident-Platzierung verwenden (minor; Defaultgröße kann Kollisionsprüfung verfälschen, gespeicherte Maße sind korrekt).
Kein Push/Merge/Deployment. Status bleibt In Progress bis zur ausdrücklichen manuellen Abnahme.

Follow-up: CodeRabbit minor in server/resident.ts – use preset dimensions for placeBeside collision checks (declined for this branch: stored dimensions are already canonical; non-blocking placement follow-up tracked as TASK-80). The hypothetical wrong-size creation is not reproducible because actions.createFrame always replaces ordinary preset dimensions with the catalog values.

Finale Controller-Verifikation auf 2f9eae2: 210/210 Testdateien, 1875/1875 Tests bestanden, keine übersprungen (390,05s; --maxWorkers=2). Typecheck, vollständiges Lint, Build und Whitespace-Prüfung bestanden. Abschließendes unabhängiges Re-Review: alle drei finalen Findings adressiert, keine neue Critical/Important-Breakage. CodeRabbit-Wiederholung: keine Major/Critical-Findings; verbleibender Minor ist TASK-80. Bekannte localStorage-/ECONNREFUSED-/AbortError-Stderr-Ausgaben und Vite-Chunk-Hinweis dokumentiert.
Alle technischen Akzeptanzkriterien verifiziert. Manuelle Geräte-/Nutzerabnahme und externes PostgreSQL-Deployment nicht behauptet; Status bleibt In Progress.

Nach Abschluss aller Prüfungen hat der Nutzer ausdrücklich Push und Pull Request im Fork mmeister86/prowin_designer gewählt. Kein Merge oder Task-Done ohne weitere ausdrückliche Freigabe. Branch und Worktree bleiben für PR-Feedback erhalten.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Integriere fünf persistente Kernformate mit separatem Preset-Dialog, optionalem Frame.preset, Datenbankmigration und Legacy-Kompatibilität. Schütze Preset-Maße serverseitig über Canvas-Creator-Rechte und erhalte Formatzuordnung in Kopier-/Undo-Pfaden.

PR #9: https://github.com/mmeister86/prowin_designer/pull/9 – Merge am 02.11.2026 bestätigt. Implementierungsprüfung: 1875 Tests sowie Typecheck, Lint, Build und Docs-Lint bestanden; heute nicht erneut ausgeführt. Verbleibendes Platzierungs-Follow-up: TASK-80.

Schließe den Task auf ausdrückliche Nutzerfreigabe vom 03.11.2026; keine zusätzliche manuelle Geräteprüfung behauptet.
<!-- SECTION:FINAL_SUMMARY:END -->
