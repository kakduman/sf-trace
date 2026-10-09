# Reference-data scripts

These built reference files in `server/beta3/reference/` from downloads in `data/beta3/raw/`:

- `build_tep.py`, then `assemble.py`: `muni-stop-ridership.json`. This is SFMTA's 2006–07 stop-level counts (TEP), matched to today's Muni stops.
- `build_schools.py`, then `assemble_schools.py`: `sf-schools.json`. This is CDE enrollment and directory data, plus private-school affidavits and SFUSD bell times.

Intermediate files go in `data/beta3/work/research/` (gitignored). Put the Muni GTFS (`data/beta3/raw/gtfs/muni.zip`), unzipped, in `gtfs_muni/` there.

Two steps were checked by hand and aren't fully automatic:

- matching the old TEP stop names to today's stops;
- matching private schools to OpenStreetMap.

The scripts record how each row was matched.
