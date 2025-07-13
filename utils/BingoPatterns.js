function checkBingoPattern(card, drawnNumbers, markedNumbers) {
  const size = 5;
  const isMatched = (num) =>
    num === 0 || (drawnNumbers.has(num) && markedNumbers.has(num)); // ✅ must be drawn AND selected

  const pattern = Array(size * size).fill(false);

  // ✅ Check rows
  for (let r = 0; r < size; r++) {
    if (card[r].every((num) => isMatched(num))) {
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

  // ✅ Main Diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMatched(card[i][i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + i] = true;
    }
    return pattern;
  }

  // ✅ Anti-Diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMatched(card[i][size - 1 - i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + (size - 1 - i)] = true;
    }
    return pattern;
  }

  // ✅ Corner pattern (optional but requested)
  const corners = [
    [0, 0],
    [0, 4],
    [4, 0],
    [4, 4],
  ];
  const allCornersMatched = corners.every(([r, c]) =>
    isMatched(card[r][c])
  );

  if (allCornersMatched) {
    for (const [r, c] of corners) {
      pattern[r * size + c] = true;
    }
    return pattern;
  }

  return pattern; // All false = no win
}
