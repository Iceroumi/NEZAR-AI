# NEZAR Blockly Block Reference for AI

This document describes all blocks available in **NEZAR** — a Blockly-based visual AI agent builder.
Use this as context/reference when generating NEZAR blockly chains as JSON.

## Overview

NEZAR chains are **vertical sequences of statement blocks**. Each block does an action
(call AI, run terminal command, wait, print, etc.). Variables flow between blocks —
an AI response saved in block N can be read by block N+1.

Two block categories:
- **Output blocks** (oval, return String) — `nezar_prompt`, `nezar_text`, `nezar_join`, `variables_get`, `text`, `math_number`
- **Statement blocks** (puzzle-shaped, chained vertically via `next`) — `nezar_send_deepseek`, `nezar_send_native`, `nezar_print`, `nezar_wait`, etc.

All value inputs accept only **String** type (square slots). Numbers are passed as strings.

---

## Quick Reference Table

| Block ID | Visual | Type | Purpose |
|---|---|---|---|
| `nezar_prompt` | `ПРОМПТ` | output | User's prompt text from input field |
| `nezar_text` | `текст %1` | output | String constant |
| `nezar_join` | `%1 + %2` | output | Concatenate two strings |
| `nezar_get_var` | `переменная %1` | output | Get variable by name (legacy) |
| `nezar_send_deepseek` | `запрос к deepseek %1 вкладка %2 ответ в %3` | statement | Call DeepSeek AI |
| `nezar_send_qwen` | `запрос к qwen %1 вкладка %2 ответ в %3` | statement | Call Qwen AI |
| `nezar_send_alice` | `запрос к алисе %1 вкладка %2 ответ в %3` | statement | Call Yandex Alice AI |
| `nezar_send_native` | `терминал native %1 папка %2 вывод в %3` | statement | Execute terminal command via Native Messaging |
| `nezar_open_tab` | `открыть вкладку %1` | statement | Open URL in new browser tab (background, waits up to 30s for load) |
| `nezar_print` | `вывести в чат %1` | statement | Print text to chat |
| `nezar_wait` | `подождать %1 сек` | statement | Sleep N seconds |
| `nezar_skill` | `навык %1 %2` | statement | Define a function (skill) |
| `nezar_call_skill` | `вызов скила %1` | statement | Call previously defined skill |
| `variables_get` | (Blockly built-in) | output | Read variable value |
| `variables_set` | (Blockly built-in) | statement | Write variable value |
| `controls_if` | (Blockly built-in) | statement | if / else if / else |
| `controls_repeat_ext` | (Blockly built-in) | statement | Repeat N times |
| `controls_whileUntil` | (Blockly built-in) | statement | while / until loop |
| `logic_compare` | (Blockly built-in) | output | =, ≠, <, >, ≤, ≥ |
| `logic_operation` | (Blockly built-in) | output | AND, OR |
| `logic_negate` | (Blockly built-in) | output | NOT |
| `logic_boolean` | (Blockly built-in) | output | true, false |
| `math_number` | (Blockly built-in) | output | Number literal |
| `math_arithmetic` | (Blockly built-in) | output | +, −, ×, ÷ |

---

## Detailed Block Reference

### 🟢 Output blocks (return String)

#### `nezar_prompt`
Returns the user's prompt text typed in the chat input field before pressing Run.

```json
{ "type": "nezar_prompt" }
```
No inputs. Use it as the first block's TEXT to inject user input.

#### `nezar_text`
String constant. Field `TEXT` holds the value.

```json
{
  "type": "nezar_text",
  "fields": { "TEXT": "hello world" }
}
```

#### `nezar_join`
Concatenates two strings. Inputs `A` and `B` (both String).

```json
{
  "type": "nezar_join",
  "inputs": {
    "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "Hello, " } } },
    "B": { "block": { "type": "nezar_prompt" } }
  }
}
```
Result: `"Hello, " + promptText`.

#### `variables_get`
Reads variable value by name. Field `VAR` is an object `{ "name": "varName" }`.

```json
{
  "type": "variables_get",
  "fields": { "VAR": { "name": "ai_response" } }
}
```

---

### 🟦 AI request blocks (statement)

#### `nezar_send_deepseek`
Sends TEXT to a DeepSeek chat tab (URL), saves response to a variable.

**Inputs:**
- `TEXT` (String) — prompt to send
- `URL` (String) — DeepSeek chat URL, e.g. `"https://chat.deepseek.com"`
- `VAR` (String, must be `variables_get`) — variable name to save response

```json
{
  "type": "nezar_send_deepseek",
  "inputs": {
    "TEXT": { "block": { "type": "nezar_prompt" } },
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "goal" } } } }
  }
}
```

**Important:** `VAR` slot must contain a `variables_get` block whose name is the **storage target**.
The interpreter reads the variable NAME from this block (not value), and writes the AI response there.

#### `nezar_send_qwen`
Same structure as `nezar_send_deepseek`. Default URL: `https://chat.qwen.ai`.

#### `nezar_send_alice`
Same structure. Default URL: `https://alice.yandex.ru`.

---

### 🟧 Terminal block (statement)

#### `nezar_send_native`
Executes a shell command via Native Messaging. Returns stdout + stderr.

**Inputs:**
- `TEXT` (String) — command to execute
- `CWD` (String) — working directory path, e.g. `"/tmp"` or `"/home/user/project"`
- `VAR` (String, must be `variables_get`) — variable name to save output

```json
{
  "type": "nezar_send_native",
  "inputs": {
    "TEXT": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "cmd" } } } },
    "CWD": { "block": { "type": "nezar_text", "fields": { "TEXT": "/tmp" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "output" } } } }
  }
}
```

The TEXT slot often contains a `variables_get` block reading from a previous AI response.

---

### 🟧 Browser block (statement)

#### `nezar_open_tab`
Opens a URL in a new browser tab (in the background — user stays in NEZAR). Waits up to 30 seconds for the tab to finish loading, then continues the chain. Useful for:
- Pre-opening AI chat tabs before calling them (`https://chat.deepseek.com`)
- Navigating to documentation pages
- Opening URLs returned by AI in previous blocks

**Inputs:**
- `URL` (String) — full URL including protocol (`https://`, `http://`)

```json
{
  "type": "nezar_open_tab",
  "inputs": {
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } }
  }
}
```

The URL can come from a previous AI response:
```json
{
  "type": "nezar_open_tab",
  "inputs": {
    "URL": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "extracted_url" } } } }
  }
}
```

**Notes:**
- Tab opens with `active: false` (in background). User stays focused on NEZAR.
- Cannot open `chrome://` URLs or `file://` URLs (Chrome MV3 restrictions).
- If the page hasn't loaded within 30 sec, returns OK anyway (the tab IS open, just still loading).
- Emits a chat message: `📂 Opened tab: <URL> (tabId=N)` on success.

---

### 🟫 Utility statement blocks

#### `nezar_print`
Adds a text message to the chat (visible as an AI-side bubble).

```json
{
  "type": "nezar_print",
  "inputs": {
    "TEXT": { "block": { "type": "nezar_text", "fields": { "TEXT": "Done!" } } }
  }
}
```

#### `nezar_wait`
Pauses execution for N seconds (max 300).

```json
{
  "type": "nezar_wait",
  "inputs": {
    "TIME": {
      "shadow": {
        "type": "nezar_text",
        "fields": { "TEXT": "1" }
      }
    }
  }
}
```
Note: `TIME` is a String. Use `nezar_text` shadow with a numeric string ("1", "2.5").

---

### 🟪 Skill blocks (function definition + call)

#### `nezar_skill`
Defines a named function. Body is the `DO` statement chain.

**Inputs:**
- `NAME` (String) — skill name (e.g. `"go"`, `"analyze"`)
- `DO` (statement) — body chain

```json
{
  "type": "nezar_skill",
  "inputs": {
    "NAME": { "block": { "type": "nezar_text", "fields": { "TEXT": "go" } } },
    "DO": {
      "block": {
        "type": "nezar_print",
        "inputs": { "TEXT": { "block": { "type": "nezar_text", "fields": { "TEXT": "skill ran" } } } }
      }
    }
  }
}
```
Skill definitions are stored at execution start. They don't run on their own — use `nezar_call_skill` to invoke.

#### `nezar_call_skill`
Calls a previously defined skill by name.

```json
{
  "type": "nezar_call_skill",
  "inputs": {
    "NAME": { "block": { "type": "nezar_text", "fields": { "TEXT": "go" } } }
  }
}
```

---

### Standard Blockly blocks (built-in)

#### `variables_set`
Writes variable value.

```json
{
  "type": "variables_set",
  "fields": { "VAR": { "name": "counter" } },
  "inputs": {
    "VALUE": { "block": { "type": "nezar_text", "fields": { "TEXT": "0" } } }
  }
}
```

#### `controls_if`
If / else if / else chain.

```json
{
  "type": "controls_if",
  "inputs": {
    "IF0": { "block": { "type": "logic_compare", "fields": { "OP": "EQ" },
      "inputs": {
        "A": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "exit_code" } } } },
        "B": { "block": { "type": "nezar_text", "fields": { "TEXT": "0" } } }
      } } },
    "DO0": { "block": { "type": "nezar_print",
      "inputs": { "TEXT": { "block": { "type": "nezar_text", "fields": { "TEXT": "Success" } } } } } }
  }
}
```

#### `controls_repeat_ext`
Repeat N times.

```json
{
  "type": "controls_repeat_ext",
  "inputs": {
    "TIMES": { "shadow": { "type": "math_number", "fields": { "NUM": 3 } } },
    "DO": { "block": { "type": "nezar_print",
      "inputs": { "TEXT": { "block": { "type": "nezar_text", "fields": { "TEXT": "loop iter" } } } } } }
  }
}
```

#### `logic_compare`
Comparison operators: `EQ` (=), `NEQ` (≠), `LT` (<), `LTE` (≤), `GT` (>), `GTE` (≥).

#### `logic_operation`
Boolean: `AND` or `OR`.

#### `logic_negate`
NOT.

#### `logic_boolean`
Boolean literal: `"TRUE"` or `"FALSE"`.

#### `math_number`
Number literal (used for repeat counts, etc.).

```json
{ "type": "math_number", "fields": { "NUM": 5 } }
```

#### `math_arithmetic`
Arithmetic: `ADD`, `MINUS`, `MULTIPLY`, `DIVIDE`.

---

## How Blocks Connect

### Statement chaining (vertical)
Statement blocks have `previousStatement` and `nextStatement` slots. They stack vertically:

```json
{
  "type": "nezar_send_deepseek",
  "inputs": { ... },
  "next": {
    "block": {
      "type": "nezar_wait",
      "inputs": { ... },
      "next": {
        "block": { "type": "nezar_print", "inputs": { ... } }
      }
    }
  }
}
```

### Value block nesting (horizontal)
Output blocks are nested inside `inputs` of statement blocks:

```json
{
  "type": "nezar_send_deepseek",
  "inputs": {
    "TEXT": {
      "block": { "type": "nezar_text", "fields": { "TEXT": "hello" } }
    }
  }
}
```

### Variables flow between blocks
- Block 1: `nezar_send_deepseek` with `VAR` = `variables_get("goal")` → saves response to `goal`
- Block 2: `nezar_send_deepseek` with `TEXT` = `variables_get("goal")` → reads `goal` value

Variables are global per execution. Defined dynamically when first written.

---

## JSON Output Format for AI

When generating a NEZAR chain, output a **single top-level block** in this format:

```json
{
  "type": "<block_type>",
  "x": 30,
  "y": 30,
  "fields": { ... },
  "inputs": {
    "<input_name>": {
      "block": { ... nested block ... },
      "shadow": { ... optional shadow block ... }
    }
  },
  "next": {
    "block": { ... next statement in chain ... }
  }
}
```

### Rules
1. Top-level block must be a **statement** type (not output).
2. `x`, `y` are workspace coordinates (use small values like 30).
3. `fields` for input fields (text value, dropdown value, variable name).
4. `inputs` for value/statement inputs — each contains `block` (the connected block) and optionally `shadow` (a fallback block shown when no real block connected).
5. `next` chains to the next statement block.
6. Variable references use `{ "VAR": { "name": "varName" } }` format.
7. **Always include `URL` input for AI blocks** (use `"https://chat.deepseek.com"`, `"https://chat.qwen.ai"`, or `"https://alice.yandex.ru"`).
8. **Always include `VAR` input as `variables_get`** for AI/terminal blocks (otherwise response is lost).

---

## Example Chains

### Example 1: Simple echo
User prompt → AI rephrases → print result

```json
{
  "type": "nezar_send_deepseek",
  "x": 30, "y": 30,
  "inputs": {
    "TEXT": { "block": { "type": "nezar_prompt" } },
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "ai_reply" } } } }
  },
  "next": {
    "block": {
      "type": "nezar_print",
      "inputs": {
        "TEXT": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "ai_reply" } } } }
      }
    }
  }
}
```

### Example 2: AI-then-terminal agent
User prompt → AI proposes command → execute → print output

```json
{
  "type": "nezar_send_deepseek",
  "x": 30, "y": 30,
  "inputs": {
    "TEXT": {
      "block": {
        "type": "nezar_join",
        "inputs": {
          "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "User wants: '" } } },
          "B": { "block": { "type": "nezar_prompt" } }
        }
      }
    },
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "goal" } } } }
  },
  "next": {
    "block": {
      "type": "nezar_send_deepseek",
      "inputs": {
        "TEXT": {
          "block": {
            "type": "nezar_join",
            "inputs": {
              "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "Goal: '" } } },
              "B": { "block": {
                "type": "nezar_join",
                "inputs": {
                  "A": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "goal" } } } },
                  "B": { "block": { "type": "nezar_text", "fields": { "TEXT": "'. Give ONE safe Linux command (just the command)." } } }
                }
              } }
            }
          }
        },
        "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
        "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "cmd" } } } }
      },
      "next": {
        "block": {
          "type": "nezar_send_native",
          "inputs": {
            "TEXT": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "cmd" } } } },
            "CWD": { "block": { "type": "nezar_text", "fields": { "TEXT": "/tmp" } } },
            "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "output" } } } }
          },
          "next": {
            "block": {
              "type": "nezar_print",
              "inputs": {
                "TEXT": {
                  "block": {
                    "type": "nezar_join",
                    "inputs": {
                      "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "Result: " } } },
                      "B": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "output" } } } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### Example 3: Two-model debate (DeepSeek vs Qwen)
DeepSeek gives opinion → Qwen critiques → DeepSeek finalizes

```json
{
  "type": "nezar_send_deepseek",
  "x": 30, "y": 30,
  "inputs": {
    "TEXT": { "block": { "type": "nezar_prompt" } },
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "ds_opinion" } } } }
  },
  "next": {
    "block": {
      "type": "nezar_send_qwen",
      "inputs": {
        "TEXT": {
          "block": {
            "type": "nezar_join",
            "inputs": {
              "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "Critique this in 2 sentences: " } } },
              "B": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "ds_opinion" } } } }
            }
          }
        },
        "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.qwen.ai" } } },
        "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "qwen_critique" } } } }
      },
      "next": {
        "block": {
          "type": "nezar_send_deepseek",
          "inputs": {
            "TEXT": {
              "block": {
                "type": "nezar_join",
                "inputs": {
                  "A": { "block": { "type": "nezar_text", "fields": { "TEXT": "Your opinion: " } } },
                  "B": { "block": {
                    "type": "nezar_join",
                    "inputs": {
                      "A": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "ds_opinion" } } } },
                      "B": { "block": {
                        "type": "nezar_join",
                        "inputs": {
                          "A": { "block": { "type": "nezar_text", "fields": { "TEXT": ". Critique: " } } },
                          "B": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "qwen_critique" } } } }
                        }
                      } }
                    }
                  } }
                }
              }
            },
            "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
            "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "final" } } } }
          },
          "next": {
            "block": {
              "type": "nezar_print",
              "inputs": {
                "TEXT": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "final" } } } }
              }
            }
          }
        }
      }
    }
  }
}
```

### Example 4: Skill definition + call
Define a "greet" skill, then call it

```json
{
  "type": "nezar_skill",
  "x": 30, "y": 30,
  "inputs": {
    "NAME": { "block": { "type": "nezar_text", "fields": { "TEXT": "greet" } } },
    "DO": {
      "block": {
        "type": "nezar_print",
        "inputs": {
          "TEXT": { "block": { "type": "nezar_text", "fields": { "TEXT": "Hello from skill!" } } }
        }
      }
    }
  },
  "next": {
    "block": {
      "type": "nezar_call_skill",
      "inputs": {
        "NAME": { "block": { "type": "nezar_text", "fields": { "TEXT": "greet" } } }
      }
    }
  }
}
```

### Example 5: Conditional execution
If AI's command contains "rm" → don't execute, print warning instead

```json
{
  "type": "nezar_send_deepseek",
  "x": 30, "y": 30,
  "inputs": {
    "TEXT": { "block": { "type": "nezar_prompt" } },
    "URL": { "block": { "type": "nezar_text", "fields": { "TEXT": "https://chat.deepseek.com" } } },
    "VAR": { "block": { "type": "variables_get", "fields": { "VAR": { "name": "cmd" } } } }
  },
  "next": {
    "block": {
      "type": "controls_if",
      "inputs": {
        "IF0": {
          "block": {
            "type": "logic_operation",
            "fields": { "OP": "OR" },
            "inputs": {
              "A": { "block": { "type": "nezar_print", "fields": {} } }
            }
          }
        }
      }
    }
  }
}
```
*(Note: full substring check is complex in pure Blockly; for safety, prefer prompts that ask AI for safe commands only.)*

---

## Tips for AI when generating chains

1. **Always include `URL` input for AI blocks** — even though default exists, explicit URL makes intent clear.
2. **`VAR` must be `variables_get` block** — never `nezar_text` with var name string. The interpreter reads the NAME from `variables_get`.
3. **Variable names should be descriptive**: `goal`, `cmd`, `output`, `final_answer` — not `x`, `y`, `var1`.
4. **Use `nezar_join` for string interpolation** — there's no template literal block. Nest joins for 3+ parts.
5. **Add `nezar_wait` between consecutive AI calls** — gives the AI chat time to settle (1-2 sec).
6. **Add `nezar_print` at the end** — so the user sees the final result in chat.
7. **Keep chains ≤ 10 blocks** — longer chains are hard to debug. Use `nezar_skill` to split into functions.
8. **Avoid infinite loops** — `controls_whileUntil` has safety limit of 1000 iterations.
9. **For terminal commands, always specify `CWD`** — usually `/tmp` for safety, or the project path.
10. **Prompts should be in English or Russian** — both work, but English tends to give more reliable commands from DeepSeek.

---

## Common Patterns

### Pattern: AI → Terminal → AI verification
```
1. send_deepseek(prompt) → cmd
2. send_native(cmd, /tmp) → output
3. send_deepseek("Verify this output: " + output) → verdict
4. print(verdict)
```

### Pattern: Multi-model consensus
```
1. send_deepseek(prompt) → ds_answer
2. send_qwen(prompt) → qwen_answer
3. send_alice(prompt) → alice_answer
4. send_deepseek("Compare: " + ds_answer + ", " + qwen_answer + ", " + alice_answer) → consensus
5. print(consensus)
```

### Pattern: Retry on failure
```
1. send_native(cmd, /tmp) → output
2. controls_if (output is empty):
   - send_deepseek("The command '...' returned empty. Try different approach.") → new_cmd
   - send_native(new_cmd, /tmp) → output
3. print(output)
```

### Pattern: Skill-based architecture
```
1. skill "analyze" → DO: send_deepseek(...) → analysis
2. skill "execute" → DO: send_native(...) → result
3. skill "verify"  → DO: send_deepseek(...) → verdict
4. call_skill "analyze"
5. call_skill "execute"
6. call_skill "verify"
7. print(verdict)
```

### Pattern: Pre-open AI tab then call it
```
1. open_tab("https://chat.deepseek.com")
2. wait 3 sec  (дать вкладке загрузиться)
3. send_deepseek(prompt, "https://chat.deepseek.com") → response
4. print(response)
```

### Pattern: AI extracts URL, browser opens it
```
1. send_deepseek("Give me URL of official Python docs") → url
2. open_tab(url)
3. print("Opened: " + url)
```

---

## File format

When saving a chain as `.nezar.json` file, wrap it with metadata:

```json
{
  "format": "nezar-blockly-v2",
  "savedAt": "2026-11-08T15:00:00Z",
  "blockCount": 5,
  "projectId": "proj_xxx",
  "projectName": "My Agent",
  "workspace": {
    "blocks": {
      "blocks": [ <top-level-block-json-here> ]
    },
    "variables": [
      { "name": "goal", "id": "var-id-1" },
      { "name": "cmd", "id": "var-id-2" }
    ]
  },
  "runtimeVariables": { "goal": "...", "cmd": "..." },
  "skills": {},
  "promptText": "user's original prompt"
}
```

For **pasting via right-click → "Paste JSON"**, you can paste either:
- A single block JSON (top-level `{ "type": "nezar_...", ... }`)
- A full workspace state (`{ "blocks": { "blocks": [...] }, "variables": [...] }`)

The paste handler will extract the first top-level block from a workspace state, or use the single block directly.
