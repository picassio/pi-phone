/**
 * Every web search provider, one file each: pi-web-access's (MIT), ported to `SearchProvider`, and OpenRouter. Bright
 * Data is not here yet: it needs a SERP zone besides its key, which Settings › Web access has no field for.
 */
import anysearch from "./anysearch.ts";
import baizhi from "./baizhi.ts";
import bocha from "./bocha.ts";
import brave from "./brave.ts";
import ceramic from "./ceramic.ts";
import deepseek from "./deepseek.ts";
import degoog from "./degoog.ts";
import duckduckgo from "./duckduckgo.ts";
import exa from "./exa.ts";
import firecrawl from "./firecrawl.ts";
import gemini from "./gemini.ts";
import jina from "./jina.ts";
import kagi from "./kagi.ts";
import keenable from "./keenable.ts";
import kimi from "./kimi.ts";
import mistral from "./mistral.ts";
import ollama from "./ollama.ts";
import openai from "./openai.ts";
import openrouter from "./openrouter.ts";
import parallelMcp from "./parallel-mcp.ts";
import parallel from "./parallel.ts";
import perplexity from "./perplexity.ts";
import querit from "./querit.ts";
import search1api from "./search1api.ts";
import searchinfinity from "./searchinfinity.ts";
import searxng from "./searxng.ts";
import serpapi from "./serpapi.ts";
import serpbase from "./serpbase.ts";
import serpdive from "./serpdive.ts";
import serper from "./serper.ts";
import serply from "./serply.ts";
import tavily from "./tavily.ts";
import tinyfish from "./tinyfish.ts";
import valyu from "./valyu.ts";
import xai from "./xai.ts";
import xcrawl from "./xcrawl.ts";
import you from "./you.ts";
import zai from "./zai.ts";
import type { SearchProvider } from "../types.ts";

/** In the order Settings › Web access lists them: by name. */
export const PROVIDERS: readonly SearchProvider[] = [anysearch, baizhi, bocha, brave, ceramic, deepseek, degoog, duckduckgo, exa, firecrawl, gemini, jina, kagi, keenable, kimi, mistral, ollama, openai, openrouter, parallelMcp, parallel, perplexity, querit, search1api, searchinfinity, searxng, serpapi, serpbase, serpdive, serper, serply, tavily, tinyfish, valyu, xai, xcrawl, you, zai].sort((a, b) => a.name.localeCompare(b.name));
