const SHAPE_COLORS = [
  "#FF6B6B", "#FF8E53", "#FF6B9D", "#C44569", "#F8B500",
  "#4ECDC4", "#45B7D1", "#5F27CD", "#00D2D3", "#6C5CE7",
  "#A8E6CF", "#55A3FF", "#26de81", "#FD79A8", "#FDCB6E",
  "#E17055", "#00B894", "#2D3436", "#636e72", "#DDA0DD",
  "#FF7675", "#74b9ff", "#00CEC9", "#FFEAA7", "#81ECEC",
  "#FD79A8", "#FDCB6E", "#E84393", "#00B894", "#0984e3",
  "#6C5CE7", "#A29BFE", "#2D3436", "#636E72", "#B2BEC3",
  "#FF3838", "#FF9F43", "#10AC84", "#5F27CD", "#222F3E",
  "#FF6348", "#FF9FF3", "#54A0FF", "#5F27CD", "#01A3A4"
];

export const getRandomColor = (): string => {
  return SHAPE_COLORS[Math.floor(Math.random() * SHAPE_COLORS.length)];
};
