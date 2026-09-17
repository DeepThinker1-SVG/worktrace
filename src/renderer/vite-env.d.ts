/// <reference types="vite/client" />

import type { WorkboardApi } from '../preload/api-types';

declare global {
  interface Window {
    workboard: WorkboardApi;
  }
}
