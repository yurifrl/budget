{-# OPTIONS_GHC -fno-warn-unused-binds #-}

{-# LANGUAGE DuplicateRecordFields #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE TemplateHaskell #-}

module Types ( defaultLoginRequest, defaultLiftRequest ) where

import           GHC.Generics                   ( Generic )
import           Data.Text                      ( Text )
import           Data.Aeson                     ( FromJSON
                                                , ToJSON
                                                )
import           Data.Text                      ( Text )
import Data.Aeson.DeriveNoPrefix

data LoginRequest = LoginRequest
    { login         :: !String
    , password      :: !String
    , grant_type     :: !Text
    , client_id      :: !Text
    , client_secret  :: !Text
    } deriving (Generic, Show)

defaultLoginRequest :: String -> String -> LoginRequest
defaultLoginRequest l p = LoginRequest
    { login        = l
    , password     = p
    , grant_type    = "password"
    , client_id     = "other.conta"
    , client_secret = "yQPeLzoHuJzlMMSAjC-LgNUJdUecx8XO"
    }

instance ToJSON LoginRequest

-- | LifRequest
data LiftRequest = LiftRequest
    { lifRequestQrCodeId    :: !String
    , lifRequestType          :: !String
    } deriving (Generic, Show)

defaultLiftRequest :: String -> LiftRequest
defaultLiftRequest qrcode = LiftRequest
    { lifRequestQrCodeId   = qrcode
    , lifRequestType           = "login-webapp"
    }

$(deriveJsonNoTypeNamePrefix ''LiftRequest)

-- data LoginResponse = LoginResponse
--     { accessToken :: !String
--     } deriving (Generic, Show)

-- instance FromJSON LoginResponse

-- data ProxyResponse = ProxyResponse
--     { login :: !Text
--     } deriving (Generic, Show)

-- instance FromJSON ProxyResponse

-- data ProxyAppResponse = ProxyAppResponse
--     { lift :: !Text
--     } deriving (Generic, Show)

-- instance FromJSON ProxyAppResponse
