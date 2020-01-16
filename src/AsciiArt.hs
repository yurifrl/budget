-- | https://github.com/Rufflewind/ascii-art/blob/master/Main.hs
module AsciiArt where

import Data.Word     ( Word8 )
import Codec.Picture ( Image(..), pixelAt, Pixel8, imagePixels )
import Data.List.Ordered (mergeAll)
import Control.Lens.Fold (toListOf)
import Data.Array (listArray)
-- | Convert alpha (transparency) into a character.
alphaToChar :: Image Pixel8 -> Int -> Int -> Char
alphaToChar img y x | p < 80    = ' '
                    | otherwise = '█'
  where p = pixelAt img x y

printAsciiArtString :: Image Pixel8 -> String
printAsciiArtString img@(Image w h _) = 
  mergeAll $ map (\y -> map (alphaToChar img y) [0 .. w - 1] ++ "\n") [0 .. h - 1]