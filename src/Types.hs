{-# LANGUAGE DeriveGeneric, OverloadedStrings, ScopedTypeVariables, DuplicateRecordFields #-}
{-# OPTIONS_GHC -fno-warn-unused-binds #-}
module Types where

import GHC.Generics (Generic)
import Data.Text (Text)

data Login = Login {
      login         :: String
    , password      :: String
    , grant_type    :: Text
    , client_id     :: Text
    , client_secret :: Text
} deriving (Generic, Show)
