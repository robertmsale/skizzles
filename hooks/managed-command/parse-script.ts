export type ParsedCommand = {
  words: string[];
  uncertain: boolean[];
};

/**
 * Returns unquoted words for every top-level simple command. This deliberately
 * handles only a small, well-understood shell subset: quotes and comments are
 * skipped, ordinary command separators split commands, and constructs such as
 * substitutions, grouping, or heredocs make the whole script ineligible.
 */
export function parseScriptCommands(script: string): ParsedCommand[] | undefined {
  const commands: ParsedCommand[] = [];
  let words: string[] = [];
  let uncertainty: boolean[] = [];
  let word = "";
  let wordUncertain = false;
  let wordStarted = false;
  let inSingle = false;
  let inDouble = false;
  let atWordStart = true;
  let skipRedirectionTarget = false;

  const finishWord = () => {
    if (wordStarted) {
      if (skipRedirectionTarget) skipRedirectionTarget = false;
      else {
        words.push(word);
        uncertainty.push(wordUncertain);
      }
    }
    word = "";
    wordUncertain = false;
    wordStarted = false;
  };
  const finishCommand = () => {
    finishWord();
    if (skipRedirectionTarget) return false;
    if (words.length > 0) commands.push({ words, uncertain: uncertainty });
    words = [];
    uncertainty = [];
    return true;
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;

    if (inSingle) {
      if (character === "'") inSingle = false;
      else word += character;
      continue;
    }
    if (inDouble) {
      if (character === '"') inDouble = false;
      else word += character;
      continue;
    }
    if (
      character === "\\"
      || character === "`"
      || character === "$"
      || character === "("
      || character === ")"
    ) {
      return undefined;
    }
    if (character === "'") {
      wordStarted = true;
      wordUncertain = true;
      inSingle = true;
      continue;
    }
    if (character === '"') {
      wordStarted = true;
      wordUncertain = true;
      inDouble = true;
      continue;
    }
    if (character === "#" && atWordStart) {
      while (index + 1 < script.length && script[index + 1] !== "\n") index += 1;
      atWordStart = true;
      continue;
    }
    if (character === "\n" || character === ";") {
      if (!finishCommand()) return undefined;
      atWordStart = true;
      continue;
    }
    if (character === "&" || character === "|") {
      if (!finishCommand()) return undefined;
      if (script[index + 1] === character) index += 1;
      atWordStart = true;
      continue;
    }
    if (character === "<" || character === ">") {
      finishWord();
      if (skipRedirectionTarget || script[index + 1] === character) return undefined;
      skipRedirectionTarget = true;
      atWordStart = true;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      atWordStart = true;
      continue;
    }
    word += character;
    wordStarted = true;
    atWordStart = false;
  }

  if (inSingle || inDouble || !finishCommand()) return undefined;
  return commands.length > 0 ? commands : undefined;
}
