-- | https://github.com/Rufflewind/ascii-art/blob/master/Main.hs
module AsciiArt where

import Data.Word ( Word8 )
import Codec.Picture ( Image(..), pixelAt, Pixel8 , imagePixels )
import Data.List.Ordered ( mergeAll )
import Control.Lens.Fold ( toListOf )

-- | Convert alpha (transparency) into a character.
alphaToChar :: Image Pixel8 -> Int -> Int -> Char
alphaToChar img y x | p < 80    = ' '
                    | otherwise = '█'
            where p = pixelAt img x y

-- | printAsciiArtString
printAsciiArtString :: Image Pixel8 -> String
printAsciiArtString img@(Image w h _)
  = (\x -> indent ++ x)
  $ mergeAll
  $ map (\y -> (++ indent) $ (++ "\n") $ map (alphaToChar img y) xAxis)
    yAxis
  where maxWidth = 80
        indent = replicate ((maxWidth - w) `div` 2) ' '
        yAxis = [0 .. h - 1]
        xAxis = [0 .. w - 1]
