function checkBingoPattern(card, drawnNumbers, markedNumbers) {
  const size = 5;

  if (!(drawnNumbers instanceof Set)) {
    console.warn("⚠️ drawnNumbers is not a Set:", drawnNumbers);
    return Array(size * size).fill(false);
  }
  if (!(markedNumbers instanceof Set)) {
    console.warn("⚠️ markedNumbers is not a Set:", markedNumbers);
    return Array(size * size).fill(false);
  }

  
   const isMatched = (num) => {
  if (num === 0) return true;
  const drawnHas = drawnNumbers.has(num);
  const markedHas = markedNumbers.has(num);
  console.log(`Checking num ${num}: drawnNumbers.has = ${drawnHas}, markedNumbers.has = ${markedHas}`);
  return drawnHas && markedHas;
   };

  const pattern = Array(size * size).fill(false);

  // Check rows
  for (let r = 0; r < size; r++) {
    if (card[r].every((num) => isMatched(num))) {
      for (let c = 0; c < size; c++) {
        pattern[r * size + c] = true;
      }
      return pattern;
    }
  }

  // Check columns
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

  // Main diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMatched(card[i][i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + i] = true;
    }
    return pattern;
  }

  // Anti diagonal
  if ([0, 1, 2, 3, 4].every((i) => isMatched(card[i][size - 1 - i]))) {
    for (let i = 0; i < size; i++) {
      pattern[i * size + (size - 1 - i)] = true;
    }
    return pattern;
  }

  // Corner pattern
  const corners = [
    [0, 0],
    [0, 4],
    [4, 0],
    [4, 4],
  ];
  const allCornersMatched = corners.every(([r, c]) => isMatched(card[r][c]));
  if (allCornersMatched) {
    for (const [r, c] of corners) {
      pattern[r * size + c] = true;
    }
    return pattern;
  }

  return pattern;
}

module.exports = checkBingoPattern;
