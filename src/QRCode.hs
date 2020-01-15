module QRCode where

import qualified Data.UUID.V4 as UUIDV4
import qualified Data.UUID as UUID
import Data.Maybe
import Codec.QRCode
import Codec.QRCode.JuicyPixels
import AsciiArt
import Codec.Picture ( Image ( imageHeight, imageWidth ), pixelAt)
import Control.Monad ( forM_ )

generate :: IO ()
generate = do
  uuid <- UUIDV4.nextRandom
  qrCode (UUID.toString uuid)
  undefined

qrCode :: [Char] -> IO ()
qrCode input = do
  let maxWidth = 40
  print input
  let img = toImage 1 1 
            $ fromMaybe (error "QRC.encodeTExt failed") 
            $ encodeText (defaultQRCodeOptions M) Utf8WithoutECI input
      width  = imageWidth  img
      height = imageHeight img
      indent = replicate ((maxWidth - width) `div` 2) ' '
  forM_ [0 .. height - 1] $ \ y -> do
      putStr indent
      forM_ [0 .. width - 1] $ \ x -> do
        putStr $ pixelToChar (pixelAt img x y) ""
      putStr "\n"
  print "HY"
