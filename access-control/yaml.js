"use strict";

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === '"' || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? null : quote || character;
    } else if (character === "#" && quote === null) {
      return value.slice(0, index);
    }
  }
  return value;
}

function splitProperty(text) {
  const separator = text.indexOf(":");
  if (separator < 1) {
    throw new Error(`Invalid YAML property: ${text}`);
  }
  return [text.slice(0, separator).trim(), text.slice(separator + 1).trim()];
}

function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.trim())
    .map((line) => ({
      indent: line.length - line.trimStart().length,
      text: line.trim(),
    }));

  function parseBlock(start, indent) {
    const isSequence = lines[start]?.indent === indent && lines[start].text.startsWith("- ");
    const value = isSequence ? [] : {};
    let index = start;

    while (index < lines.length && lines[index].indent === indent) {
      const line = lines[index];
      if (isSequence) {
        if (!line.text.startsWith("- ")) break;
        const itemText = line.text.slice(2).trim();
        if (!itemText) {
          const nested = parseBlock(index + 1, lines[index + 1].indent);
          value.push(nested.value);
          index = nested.index;
          continue;
        }

        if (!/^[A-Za-z_][\w-]*:(?:\s|$)/.test(itemText)) {
          value.push(parseScalar(itemText));
          index += 1;
          continue;
        }

        const item = {};
        const [key, rawValue] = splitProperty(itemText);
        index += 1;
        if (rawValue) {
          item[key] = parseScalar(rawValue);
        } else if (index < lines.length && lines[index].indent > indent) {
          const nested = parseBlock(index, lines[index].indent);
          item[key] = nested.value;
          index = nested.index;
        } else {
          item[key] = null;
        }

        if (index < lines.length && lines[index].indent > indent) {
          const nested = parseBlock(index, lines[index].indent);
          Object.assign(item, nested.value);
          index = nested.index;
        }
        value.push(item);
        continue;
      }

      if (line.text.startsWith("- ")) break;
      const [key, rawValue] = splitProperty(line.text);
      index += 1;
      if (rawValue) {
        value[key] = parseScalar(rawValue);
      } else if (index < lines.length && lines[index].indent > indent) {
        const nested = parseBlock(index, lines[index].indent);
        value[key] = nested.value;
        index = nested.index;
      } else {
        value[key] = null;
      }
    }

    return { value, index };
  }

  if (lines.length === 0) return {};
  return parseBlock(0, lines[0].indent).value;
}

module.exports = { parseYaml };
