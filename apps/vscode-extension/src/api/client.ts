import * as vscode from 'vscode';
import { RequestOptions } from '../types';
import { getEnterpriseConfig } from '../config/enterprise';

export class CodeLensAPIClient {
  private baseUrl: string;
  private timeout: number = 30000;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || getEnterpriseConfig().defaultApiUrl;
  }

  private async fetchJson<T>(url: string, options: RequestInit, timeout: number): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${errorText}`);
      }

      return await response.json() as T;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async request<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options?.method || 'GET';
    const timeout = options?.timeout || this.timeout;

    console.log('[CodeLensAPIClient] Request:', {
      url,
      method,
      timeout,
      body: options?.body,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (options?.body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(options.body);
    }

    try {
      const result = await this.fetchJson<T>(url, fetchOptions, timeout);
      console.log('[CodeLensAPIClient] Request success');
      return result;
    } catch (error: any) {
      console.error('[CodeLensAPIClient] Request failed:', {
        url,
        method,
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    const url = `${this.baseUrl}/health`;
    const timeout = this.timeout;

    try {
      console.log(`[CodeLensAPIClient] healthCheck request: ${url}`);
      console.log(`[CodeLensAPIClient] timeout: ${timeout}ms`);

      const startTime = Date.now();
      await this.fetchJson(url, { method: 'GET', headers: { Accept: 'application/json' } }, timeout);
      const duration = Date.now() - startTime;

      console.log(`[CodeLensAPIClient] healthCheck success (${duration}ms)`);
      return true;
    } catch (error: any) {
      console.error('[CodeLensAPIClient] healthCheck failed:', {
        url,
        baseUrl: this.baseUrl,
        timeout,
        errorType: error?.constructor?.name,
        message: error?.message,
        name: error?.name,
        cause: error?.cause,
        stack: error?.stack,
      });

      // Log more details for network errors
      if (error?.cause) {
        console.error('[CodeLensAPIClient] Error cause:', error.cause);
      }

      return false;
    }
  }

  updateBaseUrl(url: string) {
    this.baseUrl = url;
  }
}
