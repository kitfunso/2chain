// Single source of truth for domain classification.
//
// Used by:
//   - src/import/scrape-import.ts → classifies every imported spec inline so
//     no row ever lands with a non-canonical domain.
//   - scripts/reclassify-domains.ts → retroactive cleanup tool, identical
//     logic, runs over the existing DB to fix legacy rows.
//
// The keyword lists and CANONICAL set live here so adding a new domain (or
// a new keyword) is a one-file change.

export const CANONICAL_DOMAINS = new Set([
  'finance', 'code', 'research', 'docs', 'geo',
  'data', 'comms', 'ai', 'devops', 'security', 'media',
]);

// Authors whose domains were chosen by hand. Inline classify and the
// reclassify tool both skip these so curated taxonomies are never overridden.
export const CURATED_AUTHORS = new Set([
  'kitfunso', 'agent-infra', 'skills-extra', 'skills-discovery', 'first-party',
]);

interface Rule { domain: string; keywords: string[] }

const RULES: Rule[] = [
  { domain: 'finance', keywords: ['stripe','payment','crypto','bitcoin','ethereum','exchange','trading','stock','sec edgar','accounting','accountant','invoice','xero','quickbooks','plaid','coinbase','binance','wallet','financial','tax','treasury','ledger','bookkeeping','revenue','billing','subscription','investor','stock broker','financial planner','financial analyst','salesperson','sales pitcher','real estate','realtor','startup pitch','pitch generator','venture capital','statistician'] },
  { domain: 'code', keywords: [
      // 'go ' and 'java ' are too generic alone (match argot/lego/javascript spam)
      // and too restrictive with the trailing space (won't match end-of-string).
      // 'golang' is unambiguous; 'javascript' covers the JS family. Drop both.
      'typescript','javascript','python','rust','golang','c++','c#','php','ruby','kotlin','swift','scala','elixir','clojure','haskell','dart',
      'react','vue','angular','svelte','next.js','nextjs','nuxt','express','fastapi','django','flask','rails','spring','laravel','tailwind',
      'frontend','backend','full-stack','fullstack','full stack','web dev','app dev','software','developer','engineer','programmer','code review','code quality','linter','refactor','debug','testing','unit test','e2e','tdd','bdd','regex','it expert','it architect','it support','code reviewer','quality assurance','qa engineer',
      'github','gitlab','bitbucket','ide','vscode','sandbox','swagger','openapi','npm','pypi','sdk','language server','lsp','rest api','graphql','grpc','websocket',
      'linux terminal','terminal emulator','javascript console','python interpreter','sql terminal','php interpreter','r interpreter',
      'mobile','ios','android','react native','flutter','game dev','unity','unreal','godot',
    ] },
  { domain: 'research', keywords: ['arxiv','pubmed','semantic scholar','paper','research','scholar','citation','wikipedia','knowledge base','academic','literature review','dataset card','meta-analysis','survey paper','peer review','scientist','mathematician','philosopher','historian','librarian','etymolog','philosophy','math teacher','chemistry teacher','physics teacher','physicist','biolog','professor','lecturer','tutor','dictionary','dream interpreter','psycholog','sociolog','archaeolog','encyclopedia','phys','astrolog','astronom','geometry','mental health adviser'] },
  { domain: 'docs', keywords: ['pdf','ocr','docx','word document','excel','xlsx','pptx','powerpoint','markdown','readme','wiki','confluence','notion','obsidian','document extraction','tech writer','technical writer','technical translator','plagiarism checker','essay writer','academic writer','proofreader','summariz','documentation','api docs','novelist','screenwriter','biographer','novel','book report','title generator','smart domain name'] },
  { domain: 'geo', keywords: ['map','geocod','openstreetmap','google maps','weather','location','address','navigation','gps','timezone','spatial','postgis','routing','isochrone','satellite imagery','travel guide','virtual tour','tour guide','aviation','geography'] },
  { domain: 'data', keywords: ['database','sql','postgres','mysql','mongodb','redis','elasticsearch','vector database','pinecone','weaviate','qdrant','dataframe','etl','elt','scraper','scraping','crawl','snowflake','bigquery','spark','airflow','dbt','data pipeline','data engineer','data warehouse','data lake','clickhouse','duckdb','parquet','orchestrat','data analyst','data scientist','dataset','spreadsheet'] },
  { domain: 'comms', keywords: ['slack','discord','email','gmail','calendar','outlook','teams','twilio','sms','whatsapp','telegram','zoom','webex','linkedin','twitter','x.com','reddit','youtube','notification','newsletter','mailgun','sendgrid','intercom','zendesk','translator','english translator','interviewer','job interview','recruiter','motivator','motivational','communication coach','public speaker','debate coach','life coach','dating coach','customer support','customer service','advertiser','journalist','networking expert','presenter','social media','influencer','negotiator','interpreter for'] },
  { domain: 'ai', keywords: ['llm','large language model','mcp server','model context protocol','rag pipeline','embedding model','vector search','fine-tuning','langchain','langgraph','llamaindex','anthropic','openai','chatgpt','gpt-4','gpt-5','gemini','huggingface','model card','transformer','attention','prompt engineering','prompt template','prompt generator','midjourney prompt','dall-e prompt','dalle prompt','stable diffusion prompt','agent framework','agentic'] },
  { domain: 'devops', keywords: ['docker','kubernetes','k8s','terraform','ansible','helm','ci/cd','pipeline','jenkins','github actions','circleci','prometheus','grafana','observability','monitoring','logging','deployment','aws','gcp','azure','cloudflare','serverless','lambda','sre','site reliability','infrastructure','platform engineer','devops','iac','iot','system admin','sysadmin','network admin','linux','unix'] },
  { domain: 'security', keywords: ['oauth','jwt','vault','secret management','encryption','vulnerab','cve','security audit','sast','dast','firewall','waf','penetration test','pentest','rbac','iam','sso','authentication','authorization','abuseipdb','threat detect','intrusion','malware','siem','cyber security','cybersecurity','legal advisor','lawyer','attorney','compliance officer'] },
  { domain: 'media', keywords: ['image','audio','video','transcription','transcribe','whisper','tts','text-to-speech','speech-to-text','blender','figma','canva','dall-e','stable diffusion','midjourney','photo','thumbnail','ffmpeg','spotify','soundcloud','bilibili','design system','ux design','ui design','art direction','brand guideline','animation','3d model','rendering','poet','songwriter','storyteller','story teller','magician','drawing teacher','illustrator','painter','instagram','dnd','dungeon master','role play','movie critic','song recommender','ascii artist','font','typography','game master','rapper','composer','musician','chef','cook','recipe','cuisine','sommelier','fashion','stylist','makeup','interior decorator','florist'] },
];

/** Returns the best-matching canonical domain, or null if no keywords match. */
export function classifyByKeywords(text: string): string | null {
  const t = text.toLowerCase();
  let best: { domain: string; score: number } | null = null;
  for (const r of RULES) {
    let score = 0;
    for (const k of r.keywords) if (t.includes(k)) score++;
    if (score > 0 && (!best || score > best.score)) best = { domain: r.domain, score };
  }
  return best ? best.domain : null;
}

/** End-to-end resolver: respect curated authors, classify by keywords, fallback
 *  to 'docs' so every row has a canonical domain. Use this on every import. */
export function resolveDomain(args: {
  author_agent_id?: string;
  domain?: string;
  capability_text?: string;
  name?: string;
}): string {
  const current = (args.domain || '').toLowerCase();
  if (args.author_agent_id && CURATED_AUTHORS.has(args.author_agent_id) && CANONICAL_DOMAINS.has(current)) {
    return current;
  }
  const fromKeywords = classifyByKeywords(args.capability_text || args.name || '');
  if (fromKeywords) return fromKeywords;
  if (CANONICAL_DOMAINS.has(current)) return current;
  return 'docs';
}
