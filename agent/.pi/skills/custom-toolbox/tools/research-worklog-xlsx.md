# Research worklog XLSX autofill

Use this tool note when:

- the user uploaded a local `.xlsx` file
- the filename contains `研究業務日誌`
- the user asked you to fill or auto-complete it

## Command

Run:

```bash
uv run scripts/fill_research_worklog.py '<input-file>'
```

Behavior:

- input: one local `.xlsx` file path from the current turn context
- output: a sibling file named `YANG_FAN_` + original filename
- success signal: the script prints the generated output path on stdout

Example:

```bash
uv run scripts/fill_research_worklog.py 'tmp/telegram/2026-04-20/研究業務日誌（2026.3）.xlsx'
```

## Notes

- The script uses uv inline metadata for Python dependencies, so run it with `uv run`.

## After running

- Confirm the output file really exists before claiming success.
- Return the generated file in Telegram.
- Keep the final reply brief.
