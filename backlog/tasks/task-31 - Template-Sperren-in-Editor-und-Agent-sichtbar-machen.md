---
id: TASK-31
title: Template-Sperren in Editor und Agent sichtbar machen
status: Done
assignee: []
created_date: '2026-10-23T09:51:00Z'
updated_date: '2026-11-02T10:23:00Z'
labels:
  - prowin
  - implementation
milestone: m-4
dependencies:
  - TASK-30
  - TASK-24
documentation:
  - docs/prowin/doop-fork-umsetzung.md
  - docs/prowin/bezugsdokumente-referenz.md
priority: medium
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Beraterinnen sollen erlaubte Änderungen erkennen und verständliches Feedback erhalten, während Creator den vollständigen Editor behalten.

Quellen: Umsetzung § 9.2; Referenz R1.4, R4.2
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 FrameView, LayersPanel und ElementPanel zeigen Sperren; Nicht-Creator können gesperrte Elemente nicht auswählen oder bearbeiten.
- [x] #2 Farbwahl beschränkt sich auf erlaubte Tokens und Textfelder respektieren max-length; Serverfehler werden verständlich angezeigt.
- [x] #3 Agent- und MCP-Guide erklären Rollen und Attribute; ein Agent-Edit respektiert dieselben Constraints wie manuelle Edits.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Verbinde Template-Policy, Auswahl und Sperrhinweise
2. Begrenze Tokenfarben und Inline-Texte; sichere Save-Feedback/Rollback
3. Erklaere Agent-/MCP-Regeln und verifiziere reale Edits
4. Pruefe jeden Schritt und gesamten Branch mit Muse Wonder
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Nutzerfreigabe 01.11.2026: bestehenden Editor erweitern, isolierter Worktree; Muse Spark 1.3 implementiert, Muse Wonder reviewt. Designabstimmung vor Umsetzung. TASK-30/PR #7 vom Nutzer als abgeschlossen bestaetigt.

Blocker nach Worktree-Wechsel: T3 delegate_task ist nicht mehr im Tool-Katalog verfuegbar; direkter Aufruf meldet Unknown tool, erneute Discovery liefert keine T3-Tools. Gewuenschte Modelle waren vorher per orchestrator_capabilities bestaetigt (meta/muse-spark-1.3, meta/muse-wonder-1.0). Kein Ersatzmodell/CLI-Fallback verwendet. Designentwurf liegt unter docs/superpowers/specs/2026-11-01-template-editor-design.md; Builder-Review und Implementierung noch nicht gestartet.

Blocker aufgeloest durch ausdrueckliche Nutzerfreigabe fuer native OpenCode-Delegation mit denselben Modellen. Design zur Umsetzung freigegeben. Baseline: 192 Dateien / 1611 Tests PASS. Isolierter Worktree; keine Produktivcode-Aenderungen vor TDD. Builder-Check Muse Wonder: eingefrorene Nicht-Felder bleiben auswaehlbar/read-only; Agent-Authoring nur auf expliziten Auftrag, Serverrolle autorisiert.

Schritt 1 nach Muse-Wonder-Review und Nachreview freigegeben (0947230). Schritt 2 nach zwei Fix-Runden freigegeben (822862e): Tokenfarben, Unicode-/Vorfahrenlimits, Schutz eingefrorener Nachfahren, gemeinsam serialisierte HTML-Saves und atomarer lokaler Rollback. RED/GREEN-Belege in SDD-Reports; letzter Gesamtlauf 199 Dateien/1687 Tests auf 0404297, anschliessend 27 fokussierte Tests+Typecheck fuer Coalescing-Fix. Agent-/MCP-Schritt und abschliessende Branch-Verifikation noch offen.

Automatisch verifiziert am 02.11.2026: Sperrhinweise/Auswahl-/Edit-Schutz in FrameView, LayersPanel und ElementPanel; rollenbasierte zentrale Policy stimmt mit TASK-30-Guard ueberein. Token-Schnittmengen, Unicode-/Vorfahrenlimits, reale Chromium-Composition sowie Store-/Live-Rollback mit serialisierten/coalesced Saves getestet. Agent und MCP teilen TEMPLATE_GUIDE; reale erlaubte/abgelehnte Edits und Creator-Authoring per Identitaet geprueft.
Muse Spark 1.3 implementiert, Muse Wonder prueft jeden Schritt plus gesamten Branch und finale Korrekturwelle. Finales Nachreview auf c95d7ed: bereit, keine offenen Critical/Important. Eltern-Verifikation: 201 Dateien/1716 Tests PASS, 0 Skips, Typecheck/Lint/Build/Doc-lint/Diff PASS; Formatierung zweier Testdateien anschliessend korrigiert und gezielt nachgetestet. Bekannte Baseline-Hinweise: Node localStorage, happy-dom ECONNREFUSED/AbortError; Build-Chunkgroesse und Doc-lint-Mtime.
Resthinweise: physische IME/visuelle Nutzerabnahme offen; grosse erweiterte Layer-Baeume parsen HTML pro Zeile; Save-Historie waechst waehrend durchgehend beschaeftigter Sequenz und wird bei Drain freigegeben; handgeschriebenes role=" image " ist clientseitig strenger; Script-Element-Toolbar in Template kann No-op anzeigen. TASK-31 bleibt In Progress bis ausdruecklicher Nutzerabnahme. Kein Push, PR oder Merge.

Abschlussbericht mit Test-/Review-Belegen, Entscheidungen und manuellen Abnahmeschritten: docs/superpowers/reports/2026-11-02-template-editor.md. Branch task/31-template-editor bleibt lokal erhalten; keine weiteren Freigabeaktionen ausgefuehrt.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Zeige Template-Sperren im Editor und Agent

- Sichere Auswahl, Bearbeitung, Tokenfarben und Textlimits rollenbasiert ab.
- Stelle Store und Live-Dokument nach abgelehnten Saves wieder her.
- Vereinheitliche Agent- und MCP-Regeln; verifiziere 1716 Tests und Muse-Wonder-Reviews.
- Dokumentiere den gemergten PR #8 und schliesse nach ausdruecklicher Nutzerbestaetigung vom 02.11.2026.
<!-- SECTION:FINAL_SUMMARY:END -->
