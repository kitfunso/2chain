// Curated registry of well-known MCP servers.
//
// Source of truth for each entry:
//   - github.com/modelcontextprotocol/servers (Anthropic official + community)
//   - npm packages under @modelcontextprotocol/server-*
//   - awesome-mcp-servers (community lists)
//
// Each entry names: how to spawn it, what env it needs, and the tools it
// is known to advertise. The advertised tool list is verified at import
// time when --verify is passed (mcp-importer.ts spawns the server briefly,
// calls tools/list, and asserts the metadata matches).
//
// This is the OPPOSITE of the catalog-only-stub mocks — every entry
// resolves to real working code that 2chain spawns as a subprocess.

export interface McpServerEntry {
  serverId: string;                // stable slug (used as the server cache key)
  name: string;                    // human label
  /** Spawn primitive. 'npx' for npm-distributed Node servers (default).
   *  'uvx' for Python servers in the official registry. 'docker' supported
   *  but each Docker entry needs an image instead of a package. */
  runtime?: 'npx' | 'uvx' | 'docker';
  /** npm or PyPI package name; spawn via `<runtime> <package> <args>`. */
  npmPackage: string;
  args?: string[];                 // extra args (e.g. allowed-paths for filesystem)
  envPassthrough?: string[];       // env vars to forward
  description: string;             // one-line description for the registry capability text
  domain: string;                  // 2chain domain bucket
  tools: McpToolStub[];            // advertised tools, used for retrieval seeding
  homepage?: string;
}

export interface McpToolStub {
  name: string;                    // MCP tool name (must match server's advertisement)
  capabilityText: string;          // 2chain capability_text (1-3 sentences)
  inputSchema?: Record<string, unknown>;  // optional override; usually populated from MCP
}

// =============================================================================
// Anthropic-maintained official servers
// (github.com/modelcontextprotocol/servers/tree/main/src)
// =============================================================================

export const MCP_SERVERS: McpServerEntry[] = [
  {
    serverId: 'mcp-filesystem',
    name: 'Filesystem',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    // Filesystem requires explicit allowed paths.
    // Default to a safe, isolated per-tenant area at runtime; the importer
    // resolves $TWOCHAIN_MCP_FILESYSTEM_ROOTS or falls back to ~/2chain-mcp-fs.
    args: [],
    envPassthrough: [],
    description: 'Local filesystem read/write/list/search inside an explicitly allowed directory tree.',
    domain: 'docs',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tools: [
      { name: 'read_text_file', capabilityText: 'Reads the contents of a text file from the local filesystem (within an allowed root). Returns the full text, suitable for code review, log inspection, configuration audits.' },
      { name: 'write_file', capabilityText: 'Writes a string to a file on the local filesystem (within an allowed root). Creates parent directories as needed. Used for code generation, config patching, log emission.' },
      { name: 'list_directory', capabilityText: 'Lists files and subdirectories in a local directory (within an allowed root). Returns names + types. Used for project exploration, file discovery, glob staging.' },
      { name: 'search_files', capabilityText: 'Recursively searches for files matching a name pattern under a local directory. Returns matching paths. Used for "find that config file" workflows.' },
      { name: 'move_file', capabilityText: 'Moves or renames a file on the local filesystem. Within allowed roots. Used in refactor workflows + folder reorganization.' },
      { name: 'directory_tree', capabilityText: 'Returns a recursive tree view of a directory. Used to give an agent project structure context before coding.' },
      { name: 'get_file_info', capabilityText: 'Returns metadata for a file: size, mtime, permissions, owner. Used for sanity checks + caching decisions.' },
    ],
  },
  {
    serverId: 'mcp-git',
    name: 'Git',
    runtime: 'uvx',
    npmPackage: 'mcp-server-git',
    description: 'Git repository operations: status, log, diff, blame, branch, show.',
    domain: 'code',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    tools: [
      { name: 'git_status', capabilityText: 'Runs git status in a repository. Returns staged + unstaged changes, untracked files, current branch, ahead/behind. Used for safe-edit workflows.' },
      { name: 'git_log', capabilityText: 'Returns commit log for a branch or path. Includes SHA, author, date, message. Used to summarise recent work + write release notes.' },
      { name: 'git_diff', capabilityText: 'Returns the diff between two refs or working-tree-vs-HEAD. Used for code-review preparation + change audits.' },
      { name: 'git_show', capabilityText: 'Shows the content of a commit: message + diff + author. Used to inspect a specific change in detail.' },
      { name: 'git_blame', capabilityText: 'Shows the last commit that modified each line of a file. Used to find context behind a piece of code.' },
      { name: 'git_branch', capabilityText: 'Lists branches or creates a new branch from a base ref. Used to set up safe edit branches before changes.' },
    ],
  },
  {
    serverId: 'mcp-fetch',
    name: 'Fetch',
    runtime: 'uvx',
    npmPackage: 'mcp-server-fetch',
    description: 'HTTP fetch + HTML-to-markdown conversion for arbitrary public URLs.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    tools: [
      { name: 'fetch', capabilityText: 'Fetches a public URL and returns the body. For HTML pages, converts to clean markdown so an LLM can read it. Used for web research, news monitoring, doc lookups.' },
    ],
  },
  {
    serverId: 'mcp-time',
    name: 'Time',
    runtime: 'uvx',
    npmPackage: 'mcp-server-time',
    description: 'Get the current time in any IANA timezone, convert between zones.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    tools: [
      { name: 'get_current_time', capabilityText: 'Returns the current local time for a given IANA timezone (e.g. America/New_York, Europe/London). Used in scheduling + localized timestamps.' },
      { name: 'convert_time', capabilityText: 'Converts a time from one IANA timezone to another. Used for cross-timezone meeting scheduling and travel itineraries.' },
    ],
  },
  {
    serverId: 'mcp-sequentialthinking',
    name: 'Sequential Thinking',
    npmPackage: '@modelcontextprotocol/server-sequential-thinking',
    description: 'Structured chain-of-thought planner. The agent uses it to log thought steps + revise + branch.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    tools: [
      { name: 'sequentialthinking', capabilityText: 'Records a structured thought step in a multi-step reasoning trace. Supports revision + branching. Used to make agent reasoning visible + auditable on hard problems.' },
    ],
  },
  {
    serverId: 'mcp-memory',
    name: 'Memory (Knowledge Graph)',
    npmPackage: '@modelcontextprotocol/server-memory',
    description: 'In-process knowledge graph: entities, relations, observations. Per-session memory.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tools: [
      { name: 'create_entities', capabilityText: 'Creates entities in the agent\'s knowledge graph with name, type, observations. Used to build session memory of people, projects, files.' },
      { name: 'create_relations', capabilityText: 'Creates a relation between two entities in the agent\'s knowledge graph (e.g. "Alice WORKS_FOR Acme"). Used to encode structured facts.' },
      { name: 'add_observations', capabilityText: 'Appends observations to an existing entity in the agent\'s knowledge graph. Used to accumulate facts about a single subject across turns.' },
      { name: 'search_nodes', capabilityText: 'Searches the agent\'s knowledge graph for nodes matching a query. Returns entities + relations. Used to retrieve session memory on demand.' },
      { name: 'open_nodes', capabilityText: 'Opens specific entities by name in the agent\'s knowledge graph. Returns full entity + relations + observations. Used to inspect a known subject.' },
      { name: 'read_graph', capabilityText: 'Reads the entire current knowledge graph. Returns all entities + relations. Used for snapshotting + debug.' },
    ],
  },
  {
    serverId: 'mcp-everything',
    name: 'Everything',
    npmPackage: '@modelcontextprotocol/server-everything',
    description: 'Reference server exercising every MCP feature. Useful as a soak-test for MCP clients.',
    domain: 'code',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    tools: [
      { name: 'echo', capabilityText: 'Echoes its input back. Used as a connectivity smoke test for MCP transports.' },
      { name: 'add', capabilityText: 'Adds two integers and returns the result. Used as the canonical MCP tool example.' },
      { name: 'long_running_operation', capabilityText: 'Simulates a long-running operation with progress notifications. Used to test MCP progress handling on the client side.' },
      { name: 'sample_llm', capabilityText: 'Demonstrates MCP server-initiated sampling: asks the connecting agent\'s LLM to complete a prompt. Used to test sampling capability negotiation.' },
    ],
  },
  {
    serverId: 'mcp-github',
    name: 'GitHub',
    npmPackage: '@modelcontextprotocol/server-github',
    envPassthrough: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    description: 'GitHub repos, issues, PRs, files, releases via REST API. Requires a personal access token.',
    domain: 'code',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    tools: [
      { name: 'create_or_update_file', capabilityText: 'Creates or updates a file in a GitHub repository via the contents API. Used for AI-driven commits, repo bootstrapping, README generation.' },
      { name: 'search_repositories', capabilityText: 'Searches GitHub for public repositories matching a query. Returns name, owner, stars, primary language, description.' },
      { name: 'create_issue', capabilityText: 'Creates a new issue in a GitHub repository. Sets title, body, labels, assignees. Used for AI-driven backlog grooming + bug intake.' },
      { name: 'create_pull_request', capabilityText: 'Opens a pull request from a head branch to base. Sets title, body, draft flag. Used for AI-driven code submission flows.' },
      { name: 'fork_repository', capabilityText: 'Forks a repository to the authenticated user\'s account. Used as the first step in contributing back to OSS.' },
      { name: 'get_file_contents', capabilityText: 'Fetches the raw content of a file at a specific ref in a GitHub repo. Used for code-aware research, RAG, and diffing.' },
      { name: 'list_commits', capabilityText: 'Lists commits on a GitHub branch with SHA, author, message, files changed. Used for changelog + audit workflows.' },
      { name: 'search_code', capabilityText: 'Searches GitHub code across all public repos. Returns file paths and snippet matches. Used for "show me where this is used" research.' },
      { name: 'search_issues', capabilityText: 'Searches GitHub issues + PRs across repos. Filterable by repo, label, state, author. Used for triage + duplicate detection.' },
      { name: 'list_issues', capabilityText: 'Lists issues for a repo, filterable by label, state, since-date. Used for backlog dashboards + automation.' },
      { name: 'create_branch', capabilityText: 'Creates a new branch in a GitHub repository from an existing ref. Used to stage AI-driven edits behind a branch.' },
      { name: 'add_issue_comment', capabilityText: 'Adds a comment to an existing GitHub issue or PR. Used for triage updates, PR review remarks, notifications.' },
    ],
  },
  {
    serverId: 'mcp-gitlab',
    name: 'GitLab',
    npmPackage: '@modelcontextprotocol/server-gitlab',
    envPassthrough: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_API_URL'],
    description: 'GitLab projects, issues, MRs, files via REST API.',
    domain: 'code',
    tools: [
      { name: 'create_or_update_file', capabilityText: 'Creates or updates a file in a GitLab project via the API. Used for AI-driven commits + scaffolding workflows on self-hosted + GitLab.com.' },
      { name: 'search_repositories', capabilityText: 'Searches GitLab for projects matching a query. Returns project paths, IDs, stars, default branches.' },
      { name: 'create_issue', capabilityText: 'Creates an issue in a GitLab project. Sets title, description, labels, assignees, milestone.' },
      { name: 'create_merge_request', capabilityText: 'Opens a merge request from a source branch to target. Sets title, description, draft flag.' },
      { name: 'get_file_contents', capabilityText: 'Fetches the raw content of a file at a specific ref in a GitLab project. Used for code research, RAG, and patching.' },
    ],
  },
  {
    serverId: 'mcp-postgres',
    name: 'Postgres',
    npmPackage: '@modelcontextprotocol/server-postgres',
    args: [],
    envPassthrough: ['POSTGRES_CONNECTION_STRING'],
    description: 'Read-only Postgres queries against a configured DATABASE_URL.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    tools: [
      { name: 'query', capabilityText: 'Runs a read-only SQL query against a configured Postgres database. Returns rows + column types. Used for analytics, ad-hoc reporting, data exploration.' },
    ],
  },
  {
    serverId: 'mcp-sqlite',
    name: 'SQLite',
    runtime: 'uvx',
    npmPackage: 'mcp-server-sqlite',
    description: 'Read + write SQL against a local SQLite file with safety prompts.',
    domain: 'data',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    tools: [
      { name: 'read_query', capabilityText: 'Executes a SELECT query against a local SQLite database. Returns rows + columns. Used for local analytics and dataset exploration.' },
      { name: 'write_query', capabilityText: 'Executes an INSERT/UPDATE/DELETE statement against a local SQLite database. Returns rowcount. Used for local data prep + ETL.' },
      { name: 'create_table', capabilityText: 'Executes a CREATE TABLE statement against a local SQLite database. Used for schema bootstrap workflows.' },
      { name: 'list_tables', capabilityText: 'Lists all tables in a local SQLite database. Used as a discovery primitive when exploring an unknown DB.' },
      { name: 'describe_table', capabilityText: 'Returns column names + types for a SQLite table. Used to introspect a schema before writing queries.' },
    ],
  },
  {
    serverId: 'mcp-puppeteer',
    name: 'Puppeteer',
    npmPackage: '@modelcontextprotocol/server-puppeteer',
    description: 'Browser automation: navigate, screenshot, evaluate JS, fill forms via Puppeteer.',
    domain: 'docs',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    tools: [
      { name: 'puppeteer_navigate', capabilityText: 'Navigates a headless Chromium browser to a URL and waits for load. Used as the first step in scraping or visual checks.' },
      { name: 'puppeteer_screenshot', capabilityText: 'Takes a screenshot of the current page in a headless browser. Used for visual regression checks + "show me what this looks like" workflows.' },
      { name: 'puppeteer_click', capabilityText: 'Clicks an element matched by CSS selector in the headless browser. Used in form-filling and click-through automation.' },
      { name: 'puppeteer_fill', capabilityText: 'Types text into an input field matched by CSS selector. Used to fill forms in browser automation.' },
      { name: 'puppeteer_evaluate', capabilityText: 'Runs arbitrary JavaScript in the page context and returns the result. Used to extract data the DOM exposes only at runtime.' },
    ],
  },
  {
    serverId: 'mcp-brave-search',
    name: 'Brave Search',
    npmPackage: '@modelcontextprotocol/server-brave-search',
    envPassthrough: ['BRAVE_API_KEY'],
    description: 'Web search + local search via the Brave Search API.',
    domain: 'edu',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    tools: [
      { name: 'brave_web_search', capabilityText: 'Web search via Brave. Returns ranked links with titles, URLs, snippets. Used to ground LLM answers in fresh public web content.' },
      { name: 'brave_local_search', capabilityText: 'Local business + place search via Brave. Returns ranked places with addresses, phones, ratings, hours.' },
    ],
  },
  {
    serverId: 'mcp-google-maps',
    name: 'Google Maps',
    npmPackage: '@modelcontextprotocol/server-google-maps',
    envPassthrough: ['GOOGLE_MAPS_API_KEY'],
    description: 'Google Maps geocoding, places, directions, distance matrix, elevation.',
    domain: 'geo',
    tools: [
      { name: 'maps_geocode', capabilityText: 'Geocodes an address to lat/lng + place_id via Google Maps. Used for "convert address to coordinate" workflows.' },
      { name: 'maps_reverse_geocode', capabilityText: 'Reverse-geocodes lat/lng to a postal address via Google Maps. Used to label coordinates with human-readable locations.' },
      { name: 'maps_search_places', capabilityText: 'Searches for places near a coordinate or in a region. Returns name, address, rating, price level, opening hours.' },
      { name: 'maps_place_details', capabilityText: 'Returns detailed info for a Google Maps place_id: full address, hours, photos, reviews, phone, website.' },
      { name: 'maps_directions', capabilityText: 'Computes driving/walking/transit/cycling directions between origin and destination. Returns ordered steps with distance + duration.' },
      { name: 'maps_distance_matrix', capabilityText: 'Computes pairwise distance + duration between origin set and destination set. Used in TSP-style scheduling and routing.' },
    ],
  },
  {
    serverId: 'mcp-slack',
    name: 'Slack',
    npmPackage: '@modelcontextprotocol/server-slack',
    envPassthrough: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    description: 'Slack channel + message read/write via the Slack Web API.',
    domain: 'comms',
    tools: [
      { name: 'slack_list_channels', capabilityText: 'Lists Slack channels visible to the bot. Returns channel ID, name, topic, member count. Used as discovery before posting.' },
      { name: 'slack_post_message', capabilityText: 'Posts a message to a Slack channel via chat.postMessage. Supports threads and rich-text blocks.' },
      { name: 'slack_reply_to_thread', capabilityText: 'Posts a reply inside a Slack thread (uses thread_ts). Used to keep agent + human exchanges threaded.' },
      { name: 'slack_add_reaction', capabilityText: 'Adds an emoji reaction to a Slack message. Used for low-friction agent acknowledgements.' },
      { name: 'slack_get_channel_history', capabilityText: 'Fetches recent messages from a Slack channel. Returns timestamp, user, text. Used to read context before responding.' },
    ],
  },
  {
    serverId: 'mcp-google-drive',
    name: 'Google Drive',
    npmPackage: '@modelcontextprotocol/server-gdrive',
    envPassthrough: ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET'],
    description: 'Google Drive file search + read.',
    domain: 'docs',
    tools: [
      { name: 'gdrive_search', capabilityText: 'Searches Google Drive for files by name + content. Returns id, name, mimeType, modified time, owner. Used as discovery in document workflows.' },
      { name: 'gdrive_read_file', capabilityText: 'Reads a Google Drive file by ID. Converts Docs/Sheets to markdown/CSV. Used to bring Drive content into LLM context.' },
    ],
  },
  {
    serverId: 'mcp-aws-kb-retrieval',
    name: 'AWS Knowledge Base Retrieval',
    npmPackage: '@modelcontextprotocol/server-aws-kb-retrieval',
    envPassthrough: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    description: 'AWS Bedrock Knowledge Bases retrieval.',
    domain: 'data',
    tools: [
      { name: 'retrieve_from_aws_kb', capabilityText: 'Retrieves passages from an AWS Bedrock Knowledge Base for a query. Used as a managed RAG primitive on AWS.' },
    ],
  },
  {
    serverId: 'mcp-everart',
    name: 'EverArt',
    npmPackage: '@modelcontextprotocol/server-everart',
    envPassthrough: ['EVERART_API_KEY'],
    description: 'EverArt image generation across multiple model families.',
    domain: 'media',
    tools: [
      { name: 'generate_image', capabilityText: 'Generates an image from a text prompt via EverArt. Routes to Flux, Recraft, SDXL, etc. Returns a hosted PNG URL.' },
    ],
  },
  {
    serverId: 'mcp-sentry',
    name: 'Sentry',
    npmPackage: '@modelcontextprotocol/server-sentry',
    envPassthrough: ['SENTRY_AUTH_TOKEN'],
    description: 'Sentry issue retrieval + summary by ID.',
    domain: 'code',
    tools: [
      { name: 'get_sentry_issue', capabilityText: 'Fetches a Sentry issue by ID with stack trace, breadcrumbs, occurrence count, first/last seen, environment. Used to give an agent the full error context for diagnosis.' },
    ],
  },
  {
    serverId: 'mcp-redis',
    name: 'Redis',
    runtime: 'uvx',
    npmPackage: 'mcp-server-redis',
    envPassthrough: ['REDIS_URL'],
    description: 'Redis GET/SET/DEL/LIST primitives via stdio.',
    domain: 'data',
    tools: [
      { name: 'set', capabilityText: 'Sets a Redis key to a value with optional TTL. Used for cache writes + flag toggles.' },
      { name: 'get', capabilityText: 'Gets a Redis key value. Returns null if missing. Used for cache reads + flag lookups.' },
      { name: 'delete', capabilityText: 'Deletes a Redis key. Returns whether the key existed. Used for cache invalidation.' },
      { name: 'list', capabilityText: 'Scans Redis for keys matching a pattern. Returns the matched key set. Used for namespace exploration.' },
    ],
  },
];
