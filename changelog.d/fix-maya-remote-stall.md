### Fixed

- Model discovery keeps the loaded context window that llama.cpp servers report in `meta.n_ctx`. New models selected from the discovered list can use that window instead of OpenCode's default, which avoids compaction before the server's context fills. Saved model limits do not change.
