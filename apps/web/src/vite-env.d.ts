/// <reference types="vite/client" />

declare global {
  interface Window {
    __CODELENS_API_BASE_URL__?: string;
  }
}

export {};
