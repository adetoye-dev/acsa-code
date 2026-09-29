"""Who this app is when it talks to a provider.

A provider's edge can refuse a client by *signature* before it looks at the
credential, and Groq's does. Measured on `api.groq.com/openai/v1/models`, all with
the same deliberately invalid key:

    curl (default)          -> 401 invalid_api_key
    python-requests         -> 401 invalid_api_key
    no user agent at all    -> 401 invalid_api_key
    Python-urllib/3.12      -> 403 error code: 1010

`1010` is Cloudflare's "banned browser signature", so the request never reached
Groq's authentication. Python's `urllib` sends `Python-urllib/3.x` when asked for
nothing else, which is what every engine request used to look like — so a valid
Groq key was reported to the user as "the provider refused the request as not
permitted", with no provider-side cause in existence.

Both outbound paths import this: `ai_cli` (connection test, model list, chat) and
`responses_adapter` (every provider the agent reaches through the adapter). One of
them sending a different identity is the same bug waiting to be found again.

Deliberately not a browser string. Pretending to be Safari to slip past a block
works until it does not, and cannot be explained to a provider if they ask. This
names the app and the build, so an operator reading their logs can tell who called.
"""

from __future__ import annotations

import os

_VERSION = os.environ.get("ACSA_APP_VERSION", "").strip()

USER_AGENT = f"ACSA-Code/{_VERSION}" if _VERSION else "ACSA-Code"
