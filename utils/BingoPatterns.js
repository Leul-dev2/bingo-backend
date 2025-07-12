function checkBingoPattern(card, drawnNumbers) {
  const size = 5;
  const isMatched = (num) => num === 0 || drawnNumbers.has(num);
  const pattern = Array(size * size).fill(false);

  // ✅ Check rows
  for (let r = 0; r < size; r++) {
    if (card[r].every(isMatched)) {
      for (let c = 0; c < size; c++) {
        pattern[r * size + c] = true;
      }
      return pattern;
    }
  }

  // ✅ Check columns
  for (let c = 0; c < size; c++) {
    let colWin = true;
    for (let r = 0; r < size; r++) {
      if (!isMatched(card[r][c])) {
        colWin = false;
        break;
      }
    }
    if (colWin) {
      for (let r = 0; r < size; r++) {
        pattern[r * size + c] = true;
      }
      return pattern;
    }
  }

  // ✅ Check main diagonal
  if ([0, 1, 2, 3, 4].every(i => isMatched(card[i][i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + i] = true;
    }
    return pattern;
  }

  // ✅ Check anti-diagonal
  if ([0, 1, 2, 3, 4].every(i => isMatched(card[i][size - 1 - i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + (size - 1 - i)] = true;
    }
    return pattern;
  }

  return pattern; // ❌ No win = all false
}

module.exports = checkBingoPattern;
