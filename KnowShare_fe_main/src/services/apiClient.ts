const getBaseUrl = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
  // 默认使用相对路径，配合 Vite dev proxy，在生产通过环境变量显式配置。
  return envBase?.replace(/\/$/, "") ?? "";
};

type StoredTokens = {
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenType?: string | null;
  expiresIn?: number | null;
};

const TOKENS_KEY = "zhiguang_auth_tokens";

function getStoredTokens(): StoredTokens {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return {};
  }
}

function setStoredTokens(tokens: Partial<StoredTokens>): void {
  if (typeof window === "undefined") return;
  try {
    const prev = getStoredTokens();
    const merged = { ...prev, ...tokens } as StoredTokens;
    // 移除 undefined 字段，保持存储简洁
    Object.keys(merged).forEach((k) => {
      // @ts-ignore
      if (merged[k] === undefined) delete (merged as any)[k];
    });
    localStorage.setItem(TOKENS_KEY, JSON.stringify(merged));
  } catch {
    // 忽略存储错误
  }
}

let refreshPromise: Promise<void> | null = null;

async function refreshTokensIfNeeded(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  const p = (async () => {
    const baseUrl = getBaseUrl();
    const stored = getStoredTokens();
    const refreshToken = stored.refreshToken ?? null;
    if (!refreshToken) {
      throw new ApiError(401, "no refresh token available", null);
    }

    const url = baseUrl ? `${baseUrl}/api/auth/token/refresh` : "/api/auth/token/refresh";
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      credentials: "include"
    });

    if (!resp.ok) {
      // 刷新失败 -> 清除本地 token
      try {
        localStorage.removeItem(TOKENS_KEY);
      } catch {}
      let txt = "";
      try { txt = await resp.text(); } catch {}
      let data: unknown = txt;
      try { data = JSON.parse(txt); } catch {}
      throw new ApiError(resp.status, `token refresh failed: ${resp.status}`, data);
    }

    const data = await resp.json();
    // 按照后端返回结构更新存储（保留原 key）
    setStoredTokens({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      tokenType: data.tokenType,
      expiresIn: data.expiresIn
    });
  })();
  refreshPromise = p;
  try {
    await p;
  } finally {
    refreshPromise = null;
  }
}

export type ApiFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  accessToken?: string | null;
  signal?: AbortSignal;
};

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch<TResponse>(path: string, options: ApiFetchOptions = {}): Promise<TResponse> {
  const baseUrl = getBaseUrl();
  const { method = "GET", headers = {}, body, accessToken, signal } = options;

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const mergedHeaders: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...headers
  };

  // 注意：当 accessToken 显式传入 null 时，表示不要附带 Authorization 头；
  // 只有当 accessToken 为 undefined（未指定）时，才从本地存储回退读取。
  const token = accessToken === undefined ? getStoredTokens().accessToken ?? null : accessToken;
  if (token) {
    mergedHeaders.Authorization = `Bearer ${token}`;
  }

  // 若服务端启用了 CSRF 防护（如 Spring Security），尝试从 Cookie 中读取 XSRF-TOKEN 并随非幂等请求附加到头部
  const methodUpper = method.toUpperCase();
  const isIdempotent = methodUpper === "GET" || methodUpper === "HEAD" || methodUpper === "OPTIONS";
  if (!isIdempotent && typeof document !== "undefined") {
    try {
      const cookies = document.cookie ?? "";
      const match = cookies.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
      const xsrfToken = match ? decodeURIComponent(match[1]) : null;
      if (xsrfToken && !("X-XSRF-TOKEN" in mergedHeaders)) {
        mergedHeaders["X-XSRF-TOKEN"] = xsrfToken;
      }
    } catch {
      // 忽略读取失败，保持无 header
    }
  }

  const url = baseUrl ? `${baseUrl}${path}` : path;

  const doFetch = (hdrs: Record<string, string>) => fetch(url, {
    method,
    headers: hdrs,
    body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
    signal,
    credentials: "include"
  });

  let response = await doFetch(mergedHeaders);

  // 若收到 401 并且最初请求携带了 access token，则尝试静默刷新并重试一次
  if (response.status === 401 && mergedHeaders.Authorization) {
    try {
      await refreshTokensIfNeeded();
      const newToken = getStoredTokens().accessToken ?? null;
      if (!newToken) {
        // 刷新后仍无 token，继续走失败分支
      } else {
        const retryHeaders = { ...mergedHeaders, Authorization: `Bearer ${newToken}`, "X-Api-Retry": "1" };
        response = await doFetch(retryHeaders);
      }
    } catch (err) {
      // 刷新失败，抛出原始或刷新错误
      if (err instanceof ApiError) throw err;
      throw new ApiError(401, "token refresh failed", err as unknown);
    }
  }

  if (!response.ok) {
    // 统一按文本读取一次，避免重复读取导致“body stream already read”
    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      rawText = "";
    }
    let errorData: unknown = rawText;
    if (rawText) {
      try {
        errorData = JSON.parse(rawText);
      } catch {
        // 保留原始文本
      }
    }
    const message = typeof errorData === "object" && errorData !== null && "message" in errorData
      ? (errorData as { message: string }).message
      : rawText || `请求失败：${response.status}`;
    throw new ApiError(response.status, message, errorData);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return (await response.json()) as TResponse;
  }

  return (await response.text()) as TResponse;
}
