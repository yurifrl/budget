-- | https://github.com/Rufflewind/ascii-art/blob/master/Main.hs
module AsciiArt where

import Data.Word     ( Word8 )
import Codec.Picture ( Image(imageHeight, imageWidth), pixelAt, Pixel8 )
import Data.List.Ordered (mergeAll)

-- | Convert alpha (transparency) into a character.
alphaToChar :: Word8 -> Char
alphaToChar x | x < 80    = ' '
              | otherwise = '█'

printAsciiArtString :: Image Pixel8 -> String
printAsciiArtString img = 
  mergeAll $  map (\y -> map (\x -> alphaToChar (pixelAt img x y)) [0 .. width - 1] ++ "\n") [0 .. height - 1]
  where width  = imageWidth  img
        height = imageHeight img