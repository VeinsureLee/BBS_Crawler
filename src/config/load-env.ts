/**
 * Side-effect module: import this FIRST (before any module that reads env at
 * load time, e.g. adapters) to resolve and load `.env` + path config.
 * Used by standalone scripts that don't go through createCrawler.
 */
import { loadAndResolvePaths } from './paths.js';

loadAndResolvePaths();
